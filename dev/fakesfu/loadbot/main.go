// loadbot joins N headless attendees to a class through the real classroom
// API (dev server) and the SFU, exactly like the browser does: join →
// data session → subscribe "room" + publish "up" → register → hello/ping →
// pull the presenter's screen share. It reports how many are connected,
// receiving class state and receiving video.
//
//	go run ./loadbot -room Room1 -n 200
package main

import (
	"bytes"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"log"
	"math/rand"
	"net/http"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
)

var (
	base    = flag.String("api", "http://localhost:5173/api/classroom", "classroom API")
	room    = flag.String("room", "", "room name")
	n       = flag.Int("n", 200, "bots")
	rate    = flag.Int("rate", 20, "joins per second")
	dur     = flag.Duration("d", 60*time.Second, "how long to stay")
	chatPct = flag.Int("chat", 10, "percent of bots that send one chat message")
	prefix  = flag.String("name", "Bot", "attendee name prefix")

	joined, withState, withVideo, chats, failed int64
	videoBytes                                  int64
)

type meta struct {
	SessionID string `json:"sessionId"`
	TrackName string `json:"trackName"`
	NoRid     bool   `json:"noRid"` // single-layer share (older phone app)
}

func post(path string, hdr map[string]string, body any, out any) error {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	method := "POST"
	if p := path; len(p) > 0 && (contains(p, "/renegotiate") || contains(p, "/close")) {
		method = "PUT"
	}
	req, _ := http.NewRequest(method, *base+path, rd)
	req.Header.Set("Content-Type", "application/json")
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	if res.StatusCode >= 300 {
		return fmt.Errorf("%s: %d %s", path, res.StatusCode, data)
	}
	if out != nil {
		return json.Unmarshal(data, out)
	}
	return nil
}

func contains(s, sub string) bool { return bytes.Contains([]byte(s), []byte(sub)) }

type sdesc struct {
	Type string `json:"type"`
	SDP  string `json:"sdp"`
}

func newPC() *webrtc.PeerConnection {
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{BundlePolicy: webrtc.BundlePolicyMaxBundle})
	if err != nil {
		log.Fatal(err)
	}
	return pc
}

func answer(pc *webrtc.PeerConnection, offer sdesc) (sdesc, error) {
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: offer.SDP}); err != nil {
		return sdesc{}, err
	}
	ans, err := pc.CreateAnswer(nil)
	if err != nil {
		return sdesc{}, err
	}
	done := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(ans); err != nil {
		return sdesc{}, err
	}
	<-done
	return sdesc{Type: "answer", SDP: pc.LocalDescription().SDP}, nil
}

func newSession(token string) (string, map[string]string, error) {
	var s struct {
		SessionID string `json:"sessionId"`
		Sig       string `json:"sig"`
	}
	if err := post("/sfu/sessions/new", map[string]string{"x-lv-token": token}, nil, &s); err != nil {
		return "", nil, err
	}
	return s.SessionID, map[string]string{"x-lv-sig": s.Sig}, nil
}

func bot(i int, wg *sync.WaitGroup) {
	defer wg.Done()
	id := fmt.Sprintf("bot%06d%04d", rand.Intn(1e6), i)
	var j struct {
		Token    string `json:"token"`
		Identity string `json:"identity"`
		Room     struct {
			HostDataSession string `json:"hostDataSession"`
		} `json:"room"`
	}
	if err := post("", nil, map[string]any{"action": "join", "room": *room, "name": fmt.Sprintf("%s %d", *prefix, i), "id": id}, &j); err != nil {
		log.Printf("bot %d join: %v", i, err)
		atomic.AddInt64(&failed, 1)
		return
	}
	sid, sig, err := newSession(j.Token)
	if err != nil {
		log.Printf("bot %d session: %v", i, err)
		atomic.AddInt64(&failed, 1)
		return
	}
	pc := newPC()
	defer pc.Close()
	var est struct {
		SessionDescription sdesc `json:"sessionDescription"`
	}
	if err := post("/sfu/sessions/"+sid+"/datachannels/establish", sig, map[string]any{"dataChannel": map[string]string{"location": "remote", "dataChannelName": "server-events"}}, &est); err != nil {
		log.Printf("bot %d establish: %v", i, err)
		atomic.AddInt64(&failed, 1)
		return
	}
	ans, err := answer(pc, est.SessionDescription)
	if err == nil {
		err = post("/sfu/sessions/"+sid+"/renegotiate", sig, map[string]any{"sessionDescription": ans}, nil)
	}
	if err != nil {
		log.Printf("bot %d negotiate: %v", i, err)
		atomic.AddInt64(&failed, 1)
		return
	}
	type dcList struct {
		DataChannels []struct {
			ID uint16 `json:"id"`
		} `json:"dataChannels"`
	}
	var dcUp, dcRoom dcList
	err = post("/sfu/sessions/"+sid+"/datachannels/new", sig, map[string]any{"dataChannels": []map[string]any{
		{"location": "local", "dataChannelName": "up", "ordered": true},
	}}, &dcUp)
	if err == nil {
		err = post("/sfu/sessions/"+sid+"/datachannels/new", sig, map[string]any{"dataChannels": []map[string]any{
			{"location": "remote", "dataChannelName": "room", "sessionId": j.Room.HostDataSession, "ordered": true},
		}}, &dcRoom)
	}
	if err != nil || len(dcUp.DataChannels) != 1 || len(dcRoom.DataChannels) != 1 {
		log.Printf("bot %d channels: %v", i, err)
		atomic.AddInt64(&failed, 1)
		return
	}
	dcs := dcList{DataChannels: append(dcUp.DataChannels, dcRoom.DataChannels...)}
	t := true
	up, _ := pc.CreateDataChannel("up", &webrtc.DataChannelInit{Negotiated: &t, ID: &dcs.DataChannels[0].ID, Ordered: &t})
	roomCh, _ := pc.CreateDataChannel("room", &webrtc.DataChannelInit{Negotiated: &t, ID: &dcs.DataChannels[1].ID, Ordered: &t})
	if err := post("", nil, map[string]any{"action": "register", "token": j.Token, "dataSession": sid}, nil); err != nil {
		log.Printf("bot %d register: %v", i, err)
		atomic.AddInt64(&failed, 1)
		return
	}
	atomic.AddInt64(&joined, 1)

	var gotState, gotVideo int32
	var pulling sync.Once
	synced := make(chan struct{})
	var syncOnce sync.Once
	roomCh.OnMessage(func(m webrtc.DataChannelMessage) {
		var msg struct {
			T    string   `json:"t"`
			For  []string `json:"for"`
			Host struct {
				Sharing bool `json:"sharing"`
				Tracks  struct {
					Screen *meta `json:"screen"`
				} `json:"tracks"`
			} `json:"host"`
		}
		if json.Unmarshal(m.Data, &msg) != nil {
			return
		}
		switch msg.T {
		case "state":
			if atomic.CompareAndSwapInt32(&gotState, 0, 1) {
				atomic.AddInt64(&withState, 1)
			}
			if msg.Host.Sharing && msg.Host.Tracks.Screen != nil {
				scr := *msg.Host.Tracks.Screen
				pulling.Do(func() { go pull(i, j.Token, scr, &gotVideo) })
			}
		case "history":
			for _, f := range msg.For {
				if f == j.Identity {
					syncOnce.Do(func() { close(synced) })
				}
			}
		case "chat":
			atomic.AddInt64(&chats, 1)
		}
	})
	send := func(v any) {
		b, _ := json.Marshal(v)
		if up.ReadyState() == webrtc.DataChannelStateOpen {
			up.SendText(string(b))
		}
	}
	// hello until the presenter confirms, like the browser client
	go func() {
		for k := 0; k < 20; k++ {
			select {
			case <-synced:
				return
			default:
			}
			send(map[string]any{"t": "hello"})
			time.Sleep(3 * time.Second)
		}
	}()
	if rand.Intn(100) < *chatPct {
		go func() {
			<-synced
			time.Sleep(time.Duration(rand.Intn(10000)) * time.Millisecond)
			send(map[string]any{"t": "chat", "id": id, "text": fmt.Sprintf("Hello from bot %d", i)})
		}()
	}
	end := time.After(*dur)
	tick := time.NewTicker(10 * time.Second)
	for {
		select {
		case <-end:
			send(map[string]any{"t": "bye"})
			return
		case <-tick.C:
			send(map[string]any{"t": "ping"})
		}
	}
}

func pull(i int, token string, m meta, gotVideo *int32) {
	sid, sig, err := newSession(token)
	if err != nil {
		log.Printf("bot %d media session: %v", i, err)
		return
	}
	pc := newPC()
	pc.OnTrack(func(tr *webrtc.TrackRemote, _ *webrtc.RTPReceiver) {
		buf := make([]byte, 1500)
		for {
			k, _, err := tr.Read(buf)
			if err != nil {
				return
			}
			if atomic.CompareAndSwapInt32(gotVideo, 0, 1) {
				atomic.AddInt64(&withVideo, 1)
			}
			atomic.AddInt64(&videoBytes, int64(k))
		}
	})
	var res struct {
		SessionDescription sdesc `json:"sessionDescription"`
	}
	// like a phone viewer: the lighter layer when the share has one
	tr := map[string]any{"location": "remote", "sessionId": m.SessionID, "trackName": m.TrackName}
	if !m.NoRid {
		tr["simulcast"] = map[string]string{"preferredRid": "h"}
	}
	err = post("/sfu/sessions/"+sid+"/tracks/new", sig, map[string]any{"tracks": []map[string]any{tr}}, &res)
	if err == nil {
		var ans sdesc
		if ans, err = answer(pc, res.SessionDescription); err == nil {
			err = post("/sfu/sessions/"+sid+"/renegotiate", sig, map[string]any{"sessionDescription": ans}, nil)
		}
	}
	if err != nil {
		log.Printf("bot %d pull: %v", i, err)
	}
	time.Sleep(*dur)
	pc.Close()
}

func main() {
	flag.Parse()
	if *room == "" {
		log.Fatal("-room is required")
	}
	var wg sync.WaitGroup
	go func() {
		var last int64
		for range time.Tick(5 * time.Second) {
			vb := atomic.LoadInt64(&videoBytes)
			fmt.Printf("joined %d/%d · receiving class state %d · receiving video %d · chat msgs seen %d · failed %d · video %.1f Mbps total\n",
				atomic.LoadInt64(&joined), *n, atomic.LoadInt64(&withState), atomic.LoadInt64(&withVideo), atomic.LoadInt64(&chats), atomic.LoadInt64(&failed), float64(vb-last)*8/5/1e6)
			last = vb
		}
	}()
	for i := 0; i < *n; i++ {
		wg.Add(1)
		go bot(i, &wg)
		time.Sleep(time.Second / time.Duration(*rate))
	}
	wg.Wait()
	fmt.Printf("FINAL joined %d · state %d · video %d · failed %d\n", joined, withState, withVideo, failed)
}
