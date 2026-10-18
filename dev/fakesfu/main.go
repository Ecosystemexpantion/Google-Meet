// fakesfu is a small local stand-in for the Cloudflare Realtime SFU HTTPS API,
// used only by the tests in dev/. It implements the subset this app uses:
//
//	POST /v1/apps/{app}/sessions/new
//	POST /v1/apps/{app}/sessions/{id}/tracks/new      (push with offer, or pull)
//	PUT  /v1/apps/{app}/sessions/{id}/renegotiate
//	PUT  /v1/apps/{app}/sessions/{id}/tracks/close
//	PUT  /v1/apps/{app}/sessions/{id}/tracks/update   (simulcast preferredRid)
//	POST /v1/apps/{app}/sessions/{id}/datachannels/establish
//	POST /v1/apps/{app}/sessions/{id}/datachannels/new
//	PUT  /v1/apps/{app}/sessions/{id}/datachannels/close
//
// Request/response shapes follow cloudflare/realtime-examples and partytracks.
// It is not a production SFU: no auth beyond a bearer check, naive simulcast
// switching, everything in memory.
package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/pion/interceptor"
	"github.com/pion/rtcp"
	"github.com/pion/webrtc/v4"
)

type sd struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

type trackReq struct {
	Location  string `json:"location"`
	TrackName string `json:"trackName"`
	SessionID string `json:"sessionId,omitempty"`
	Mid       string `json:"mid,omitempty"`
	Simulcast *struct {
		PreferredRid string `json:"preferredRid"`
	} `json:"simulcast,omitempty"`
}

type dcReq struct {
	ID              *uint16 `json:"id,omitempty"`
	Location        string  `json:"location"`
	DataChannelName string  `json:"dataChannelName"`
	SessionID       string  `json:"sessionId,omitempty"`
	Ordered         *bool   `json:"ordered,omitempty"`
	MaxRetransmits  *uint16 `json:"maxRetransmits,omitempty"`
}

// ── registry ──────────────────────────────────────────────

type pubTrack struct {
	mu     sync.Mutex
	key    string
	codec  webrtc.RTPCodecCapability
	kind   webrtc.RTPCodecType
	layers map[string]*webrtc.TrackRemote
	pc     *webrtc.PeerConnection
	subs   map[*subTrack]bool
	ready  chan struct{}
	once   sync.Once
	closed bool
}

type subTrack struct {
	local  *webrtc.TrackLocalStaticRTP
	sender *webrtc.RTPSender
	rid    string
	pub    *pubTrack
	// sequence/timestamp rewriting so layer switches stay monotonic
	mu       sync.Mutex
	lastSeq  uint16
	lastTS   uint32
	seqOff   uint16
	tsOff    uint32
	curLayer string
	started  bool
}

type pubChan struct {
	mu   sync.Mutex
	dc   *webrtc.DataChannel
	subs map[*webrtc.DataChannel]bool
}

type session struct {
	mu       sync.Mutex
	id       string
	pc       *webrtc.PeerConnection
	midName  map[string]string
	subs     map[string]*subTrack // mid → sub
	dcs      map[uint16]*webrtc.DataChannel
	nextDC   uint16
	lastSeen time.Time
	created  time.Time
	everUp   bool // the PeerConnection has connected at least once
}

// Like Cloudflare: a session whose PeerConnection never connected is dropped
// after a while, and later calls on it get 410 "Session appears to be disconnected".
var idleDrop = 8 * time.Second

var (
	mu       sync.Mutex
	sessions = map[string]*session{}
	pubs     = map[string]*pubTrack{}
	chans    = map[string]*pubChan{}
	api      *webrtc.API
	token    = flag.String("token", "devtoken", "bearer token")
	verbose  = flag.Bool("v", false, "log every request")
)

func rid() string {
	b := make([]byte, 16)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func getPub(key string, create bool) *pubTrack {
	mu.Lock()
	defer mu.Unlock()
	p := pubs[key]
	if p == nil && create {
		p = &pubTrack{key: key, layers: map[string]*webrtc.TrackRemote{}, subs: map[*subTrack]bool{}, ready: make(chan struct{})}
		pubs[key] = p
	}
	return p
}

func newAPI() *webrtc.API {
	m := &webrtc.MediaEngine{}
	must(m.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeVP8, ClockRate: 90000, RTCPFeedback: []webrtc.RTCPFeedback{{Type: "nack"}, {Type: "nack", Parameter: "pli"}, {Type: "ccm", Parameter: "fir"}, {Type: "goog-remb"}}}, PayloadType: 96}, webrtc.RTPCodecTypeVideo))
	must(m.RegisterCodec(webrtc.RTPCodecParameters{RTPCodecCapability: webrtc.RTPCodecCapability{MimeType: webrtc.MimeTypeOpus, ClockRate: 48000, Channels: 2, SDPFmtpLine: "minptime=10;useinbandfec=1"}, PayloadType: 111}, webrtc.RTPCodecTypeAudio))
	must(webrtc.ConfigureSimulcastExtensionHeaders(m))
	ir := &interceptor.Registry{}
	must(webrtc.RegisterDefaultInterceptors(m, ir))
	se := webrtc.SettingEngine{}
	se.SetIncludeLoopbackCandidate(true)
	// The browser stays DTLS client whichever side offers, so renegotiations
	// started by either side keep the same roles.
	must(se.SetAnsweringDTLSRole(webrtc.DTLSRoleServer))
	se.SetNetworkTypes([]webrtc.NetworkType{webrtc.NetworkTypeUDP4})
	return webrtc.NewAPI(webrtc.WithMediaEngine(m), webrtc.WithInterceptorRegistry(ir), webrtc.WithSettingEngine(se))
}

func must(err error) {
	if err != nil {
		log.Fatal(err)
	}
}

func (s *session) ensurePC() error {
	if s.pc != nil {
		return nil
	}
	pc, err := api.NewPeerConnection(webrtc.Configuration{BundlePolicy: webrtc.BundlePolicyMaxBundle})
	if err != nil {
		return err
	}
	s.pc = pc
	pc.OnTrack(func(remote *webrtc.TrackRemote, recv *webrtc.RTPReceiver) {
		var mid string
		for _, t := range pc.GetTransceivers() {
			if t.Receiver() == recv {
				mid = t.Mid()
			}
		}
		s.mu.Lock()
		name := s.midName[mid]
		s.mu.Unlock()
		if name == "" {
			log.Printf("track on unknown mid %q", mid)
			return
		}
		p := getPub(s.id+"/"+name, true)
		p.mu.Lock()
		p.codec = remote.Codec().RTPCodecCapability
		p.kind = remote.Kind()
		p.pc = pc
		p.layers[remote.RID()] = remote
		p.mu.Unlock()
		p.once.Do(func() { close(p.ready) })
		go forward(p, remote)
		if remote.Kind() == webrtc.RTPCodecTypeVideo {
			go func() { // periodic keyframes so late subscribers start quickly
				for range time.Tick(2 * time.Second) {
					p.mu.Lock()
					closed := p.closed
					p.mu.Unlock()
					if closed || pc.ConnectionState() == webrtc.PeerConnectionStateClosed {
						return
					}
					pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(remote.SSRC())}})
				}
			}()
		}
	})
	pc.OnConnectionStateChange(func(st webrtc.PeerConnectionState) {
		if st == webrtc.PeerConnectionStateConnected {
			s.mu.Lock()
			s.everUp = true
			s.mu.Unlock()
		}
		if st == webrtc.PeerConnectionStateFailed || st == webrtc.PeerConnectionStateClosed {
			s.cleanup()
		}
	})
	return nil
}

func (s *session) cleanup() {
	mu.Lock()
	for k, p := range pubs {
		if strings.HasPrefix(k, s.id+"/") {
			p.mu.Lock()
			p.closed = true
			p.mu.Unlock()
			delete(pubs, k)
		}
	}
	for k := range chans {
		if strings.HasPrefix(k, s.id+"/") {
			delete(chans, k)
		}
	}
	mu.Unlock()
}

// best layer: the requested rid, else "f", else "" (no simulcast), else any.
func pickLayer(p *pubTrack, want string) string {
	if _, ok := p.layers[want]; ok && want != "" {
		return want
	}
	for _, r := range []string{"f", "h", "q", ""} {
		if _, ok := p.layers[r]; ok {
			return r
		}
	}
	for r := range p.layers {
		return r
	}
	return ""
}

func forward(p *pubTrack, remote *webrtc.TrackRemote) {
	layer := remote.RID()
	for {
		pkt, _, err := remote.ReadRTP()
		if err != nil {
			return
		}
		p.mu.Lock()
		subs := make([]*subTrack, 0, len(p.subs))
		for s := range p.subs {
			subs = append(subs, s)
		}
		p.mu.Unlock()
		for _, s := range subs {
			p.mu.Lock()
			target := pickLayer(p, s.rid)
			p.mu.Unlock()
			if target != layer {
				continue
			}
			s.mu.Lock()
			if s.curLayer != layer {
				if s.started {
					s.seqOff = s.lastSeq + 1 - pkt.SequenceNumber
					s.tsOff = s.lastTS + 3000 - pkt.Timestamp
				}
				s.curLayer = layer
			}
			out := *pkt
			out.SequenceNumber = pkt.SequenceNumber + s.seqOff
			out.Timestamp = pkt.Timestamp + s.tsOff
			s.lastSeq, s.lastTS, s.started = out.SequenceNumber, out.Timestamp, true
			s.mu.Unlock()
			s.local.WriteRTP(&out)
		}
	}
}

func requestKeyframe(p *pubTrack, layer string) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if r := p.layers[layer]; r != nil && p.pc != nil && p.kind == webrtc.RTPCodecTypeVideo {
		p.pc.WriteRTCP([]rtcp.Packet{&rtcp.PictureLossIndication{MediaSSRC: uint32(r.SSRC())}})
	}
}

func gatherAndLocal(pc *webrtc.PeerConnection, desc webrtc.SessionDescription) (*sd, error) {
	done := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(desc); err != nil {
		return nil, err
	}
	<-done
	l := pc.LocalDescription()
	return &sd{Type: l.Type.String(), SDP: l.SDP}, nil
}

// ── HTTP ──────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(v)
}

func errJSON(w http.ResponseWriter, code int, msg string) {
	writeJSON(w, code, map[string]string{"errorCode": "error", "errorDescription": msg})
}

func handler(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer "+*token {
		errJSON(w, 401, "unauthorized")
		return
	}
	// /v1/apps/{app}/sessions/...
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) < 4 || parts[0] != "v1" || parts[1] != "apps" || parts[3] != "sessions" {
		errJSON(w, 404, "not found")
		return
	}
	rest := parts[4:]
	if len(rest) == 1 && rest[0] == "new" {
		s := &session{id: rid(), created: time.Now(), midName: map[string]string{}, subs: map[string]*subTrack{}, dcs: map[uint16]*webrtc.DataChannel{}, nextDC: 2}
		mu.Lock()
		sessions[s.id] = s
		mu.Unlock()
		writeJSON(w, 201, map[string]string{"sessionId": s.id})
		return
	}
	if len(rest) < 2 {
		errJSON(w, 404, "not found")
		return
	}
	mu.Lock()
	s := sessions[rest[0]]
	mu.Unlock()
	if s == nil {
		errJSON(w, 404, "session not found")
		return
	}
	op := strings.Join(rest[1:], "/")
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.everUp && time.Since(s.created) > idleDrop && op != "renegotiate" {
		errJSON(w, 410, "Session appears to be disconnected")
		return
	}
	if err := s.ensurePC(); err != nil {
		errJSON(w, 500, err.Error())
		return
	}
	var body struct {
		SessionDescription *sd        `json:"sessionDescription"`
		Tracks             []trackReq `json:"tracks"`
		DataChannels       []dcReq    `json:"dataChannels"`
		DataChannel        *dcReq     `json:"dataChannel"`
		Force              bool       `json:"force"`
	}
	json.NewDecoder(r.Body).Decode(&body)
	var err error
	switch op {
	case "tracks/new":
		err = tracksNew(w, s, body.SessionDescription, body.Tracks)
	case "renegotiate":
		if body.SessionDescription == nil {
			errJSON(w, 400, "missing sessionDescription")
			return
		}
		s.mu.Unlock()
		err = s.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.NewSDPType(body.SessionDescription.Type), SDP: body.SessionDescription.SDP})
		s.mu.Lock()
		if err == nil {
			writeJSON(w, 200, map[string]any{})
		}
	case "tracks/close":
		err = tracksClose(w, s, body.SessionDescription, body.Tracks)
	case "tracks/update":
		for _, t := range body.Tracks {
			if sub := s.subs[t.Mid]; sub != nil && t.Simulcast != nil {
				sub.pub.mu.Lock()
				sub.rid = t.Simulcast.PreferredRid
				sub.pub.mu.Unlock()
				requestKeyframe(sub.pub, t.Simulcast.PreferredRid)
			}
		}
		writeJSON(w, 200, map[string]any{"tracks": body.Tracks})
	case "datachannels/establish":
		_, err = s.pc.CreateDataChannel("server-events", nil)
		if err == nil {
			var offer webrtc.SessionDescription
			if offer, err = s.pc.CreateOffer(nil); err == nil {
				var local *sd
				if local, err = gatherAndLocal(s.pc, offer); err == nil {
					writeJSON(w, 200, map[string]any{"requiresImmediateRenegotiation": true, "sessionDescription": local, "dataChannel": map[string]any{"id": 0, "location": "remote", "dataChannelName": "server-events"}})
				}
			}
		}
	case "datachannels/new":
		err = dcNew(w, s, body.DataChannels)
	case "datachannels/close":
		out := []map[string]any{}
		for _, d := range body.DataChannels {
			if d.ID != nil {
				if dc := s.dcs[*d.ID]; dc != nil {
					dc.Close()
					delete(s.dcs, *d.ID)
				}
				out = append(out, map[string]any{"id": *d.ID})
			}
		}
		writeJSON(w, 200, map[string]any{"dataChannels": out})
	default:
		errJSON(w, 404, "unknown op "+op)
		return
	}
	if err != nil {
		log.Printf("%s %s: %v", s.id[:6], op, err)
		errJSON(w, 400, err.Error())
	}
}

func tracksNew(w http.ResponseWriter, s *session, offer *sd, tracks []trackReq) error {
	locals := 0
	for _, t := range tracks {
		if t.Location == "local" {
			locals++
		}
	}
	if locals > 0 && locals < len(tracks) {
		errJSON(w, 400, "Pushing and Pulling in the same request is currently unsupported")
		return nil
	}
	if offer != nil && offer.Type == "offer" { // push
		for _, t := range tracks {
			s.midName[t.Mid] = t.TrackName
			getPub(s.id+"/"+t.TrackName, true)
		}
		if err := s.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer.SDP}); err != nil {
			return err
		}
		ans, err := s.pc.CreateAnswer(nil)
		if err != nil {
			return err
		}
		local, err := gatherAndLocal(s.pc, ans)
		if err != nil {
			return err
		}
		out := []map[string]any{}
		for _, t := range tracks {
			out = append(out, map[string]any{"trackName": t.TrackName, "mid": t.Mid, "location": "local"})
		}
		writeJSON(w, 200, map[string]any{"sessionDescription": local, "tracks": out, "requiresImmediateRenegotiation": false})
		return nil
	}
	// pull
	out := []map[string]any{}
	added := []*webrtc.RTPTransceiver{}
	names := []trackReq{}
	for _, t := range tracks {
		p := getPub(t.SessionID+"/"+t.TrackName, false)
		if p != nil {
			select {
			case <-p.ready:
			case <-time.After(8 * time.Second):
				p = nil
			}
		}
		if p == nil {
			out = append(out, map[string]any{"trackName": t.TrackName, "sessionId": t.SessionID, "errorCode": "not_found", "errorDescription": "track not found"})
			continue
		}
		p.mu.Lock()
		codec := p.codec
		p.mu.Unlock()
		local, err := webrtc.NewTrackLocalStaticRTP(codec, rid()[:8], "s-"+t.SessionID[:8])
		if err != nil {
			return err
		}
		tr, err := s.pc.AddTransceiverFromTrack(local, webrtc.RTPTransceiverInit{Direction: webrtc.RTPTransceiverDirectionSendonly})
		if err != nil {
			return err
		}
		sub := &subTrack{local: local, sender: tr.Sender(), pub: p}
		if t.Simulcast != nil {
			sub.rid = t.Simulcast.PreferredRid
		}
		go func() { // forward keyframe requests from the viewer to the publisher
			for {
				pkts, _, err := tr.Sender().ReadRTCP()
				if err != nil {
					return
				}
				for _, pk := range pkts {
					switch pk.(type) {
					case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
						p.mu.Lock()
						l := pickLayer(p, sub.rid)
						p.mu.Unlock()
						requestKeyframe(p, l)
					}
				}
			}
		}()
		p.mu.Lock()
		p.subs[sub] = true
		p.mu.Unlock()
		added = append(added, tr)
		names = append(names, t)
		_ = sub
	}
	if len(added) == 0 {
		writeJSON(w, 200, map[string]any{"tracks": out, "requiresImmediateRenegotiation": false})
		return nil
	}
	offerDesc, err := s.pc.CreateOffer(nil)
	if err != nil {
		return err
	}
	local, err := gatherAndLocal(s.pc, offerDesc)
	if err != nil {
		return err
	}
	for i, tr := range added {
		t := names[i]
		for p := range getPub(t.SessionID+"/"+t.TrackName, false).subsSnapshot() {
			if p.sender == tr.Sender() {
				s.subs[tr.Mid()] = p
				requestKeyframe(p.pub, pickLayer(p.pub, p.rid))
			}
		}
		out = append(out, map[string]any{"trackName": t.TrackName, "sessionId": t.SessionID, "mid": tr.Mid(), "location": "remote"})
	}
	writeJSON(w, 200, map[string]any{"sessionDescription": local, "tracks": out, "requiresImmediateRenegotiation": true})
	return nil
}

func (p *pubTrack) subsSnapshot() map[*subTrack]bool {
	if p == nil {
		return nil
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	out := map[*subTrack]bool{}
	for k := range p.subs {
		out[k] = true
	}
	return out
}

func tracksClose(w http.ResponseWriter, s *session, offer *sd, tracks []trackReq) error {
	if offer != nil {
		if err := s.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer.SDP}); err != nil {
			return err
		}
	}
	out := []map[string]any{}
	for _, t := range tracks {
		if sub := s.subs[t.Mid]; sub != nil {
			sub.pub.mu.Lock()
			delete(sub.pub.subs, sub)
			sub.pub.mu.Unlock()
			delete(s.subs, t.Mid)
		}
		if name := s.midName[t.Mid]; name != "" {
			mu.Lock()
			if p := pubs[s.id+"/"+name]; p != nil {
				p.mu.Lock()
				p.closed = true
				p.mu.Unlock()
				delete(pubs, s.id+"/"+name)
			}
			mu.Unlock()
			delete(s.midName, t.Mid)
		}
		out = append(out, map[string]any{"mid": t.Mid})
	}
	resp := map[string]any{"tracks": out, "requiresImmediateRenegotiation": false}
	if offer != nil {
		ans, err := s.pc.CreateAnswer(nil)
		if err != nil {
			return err
		}
		local, err := gatherAndLocal(s.pc, ans)
		if err != nil {
			return err
		}
		resp["sessionDescription"] = local
	}
	writeJSON(w, 200, resp)
	return nil
}

func dcNew(w http.ResponseWriter, s *session, reqs []dcReq) error {
	// Like the real service: one request may publish or subscribe, not both.
	locals := 0
	for _, d := range reqs {
		if d.Location == "local" {
			locals++
		}
	}
	if locals > 0 && locals < len(reqs) {
		errJSON(w, 400, "Pushing and Pulling in the same request is currently unsupported")
		return nil
	}
	out := []map[string]any{}
	for _, d := range reqs {
		id := s.nextDC
		s.nextDC++
		init := &webrtc.DataChannelInit{Negotiated: ptr(true), ID: &id, Ordered: d.Ordered, MaxRetransmits: d.MaxRetransmits}
		key := s.id + "/" + d.DataChannelName
		if d.Location == "remote" {
			mu.Lock()
			pc := chans[d.SessionID+"/"+d.DataChannelName]
			mu.Unlock()
			if pc == nil {
				out = append(out, map[string]any{"location": "remote", "dataChannelName": d.DataChannelName, "sessionId": d.SessionID, "errorCode": "not_found", "errorDescription": "datachannel not found"})
				continue
			}
			dc, err := s.pc.CreateDataChannel(d.DataChannelName, init)
			if err != nil {
				return err
			}
			s.dcs[id] = dc
			dc.OnOpen(func() {
				pc.mu.Lock()
				pc.subs[dc] = true
				pc.mu.Unlock()
			})
			dc.OnClose(func() {
				pc.mu.Lock()
				delete(pc.subs, dc)
				pc.mu.Unlock()
			})
			out = append(out, map[string]any{"id": id, "location": "remote", "dataChannelName": d.DataChannelName, "sessionId": d.SessionID})
			continue
		}
		dc, err := s.pc.CreateDataChannel(d.DataChannelName, init)
		if err != nil {
			return err
		}
		s.dcs[id] = dc
		ch := &pubChan{dc: dc, subs: map[*webrtc.DataChannel]bool{}}
		mu.Lock()
		chans[key] = ch
		mu.Unlock()
		dc.OnMessage(func(m webrtc.DataChannelMessage) {
			ch.mu.Lock()
			list := make([]*webrtc.DataChannel, 0, len(ch.subs))
			for c := range ch.subs {
				list = append(list, c)
			}
			ch.mu.Unlock()
			for _, c := range list {
				if m.IsString {
					c.SendText(string(m.Data))
				} else {
					c.Send(m.Data)
				}
			}
		})
		out = append(out, map[string]any{"id": id, "location": "local", "dataChannelName": d.DataChannelName})
	}
	writeJSON(w, 200, map[string]any{"dataChannels": out})
	return nil
}

func ptr[T any](v T) *T { return &v }

func main() {
	addr := flag.String("addr", "127.0.0.1:7890", "listen address")
	flag.Parse()
	api = newAPI()
	log.Printf("fake Realtime SFU on http://%s (token %q)", *addr, *token)
	log.Fatal(http.ListenAndServe(*addr, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		if *verbose {
			log.Printf("→ %s %s", r.Method, r.URL.Path)
		}
		handler(w, r)
		if d := time.Since(start); d > 2*time.Second || *verbose {
			fmt.Printf("← %s %s %v\n", r.Method, r.URL.Path, d)
		}
	})))
}
