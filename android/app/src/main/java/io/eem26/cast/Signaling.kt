package io.eem26.cast

import org.json.JSONArray
import org.json.JSONObject
import org.webrtc.PeerConnection
import java.net.HttpURLConnection
import java.net.URL

class ApiException(message: String) : Exception(message)

/**
 * HTTP calls to the class's Supabase "classroom" function — the same API the
 * web app uses. Cloudflare Realtime SFU calls go through its /sfu proxy, which
 * adds the secret key; the function signs each session we open.
 */
class Signaling(private val api: String, private val token: String) {
    var sessionId: String = ""
        private set
    private var sig: String = ""

    private fun call(path: String, method: String, body: JSONObject?, headers: Map<String, String> = emptyMap()): JSONObject {
        val conn = URL(api.trimEnd('/') + path).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = 15_000
            conn.readTimeout = 30_000
            conn.setRequestProperty("Content-Type", "application/json")
            headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }
            if (body != null) {
                conn.doOutput = true
                conn.outputStream.use { it.write(body.toString().toByteArray()) }
            }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val text = stream?.bufferedReader()?.use { it.readText() } ?: ""
            val json = try { JSONObject(text) } catch (e: Exception) { JSONObject() }
            if (code !in 200..299 || json.has("errorCode")) {
                val msg = json.optString("message").ifEmpty { json.optString("errorDescription").ifEmpty { "HTTP $code" } }
                throw ApiException(msg)
            }
            return json
        } finally {
            conn.disconnect()
        }
    }

    fun iceServers(): List<PeerConnection.IceServer> {
        val list = try { call("/sfu/generate-ice-servers", "GET", null).optJSONArray("iceServers") } catch (e: Exception) { null }
            ?: return listOf(PeerConnection.IceServer.builder("stun:stun.cloudflare.com:3478").createIceServer())
        val out = mutableListOf<PeerConnection.IceServer>()
        for (i in 0 until list.length()) {
            val s = list.getJSONObject(i)
            val urls = when (val u = s.opt("urls")) {
                is JSONArray -> (0 until u.length()).map { u.getString(it) }
                is String -> listOf(u)
                else -> continue
            }
            val b = PeerConnection.IceServer.builder(urls)
            if (s.has("username")) b.setUsername(s.getString("username"))
            if (s.has("credential")) b.setPassword(s.getString("credential"))
            out += b.createIceServer()
        }
        return out
    }

    fun newSession() {
        val r = call("/sfu/sessions/new", "POST", null, mapOf("x-lv-token" to token))
        sessionId = r.getString("sessionId")
        sig = r.getString("sig")
    }

    /** Publishes local tracks: [mid to trackName]. Returns the SFU's SDP answer. */
    fun pushTracks(offerSdp: String, tracks: List<Pair<String, String>>): String {
        val body = JSONObject()
            .put("sessionDescription", JSONObject().put("type", "offer").put("sdp", offerSdp))
            .put("tracks", JSONArray(tracks.map { (mid, name) ->
                JSONObject().put("location", "local").put("mid", mid).put("trackName", name)
            }))
        val r = call("/sfu/sessions/$sessionId/tracks/new", "POST", body, mapOf("x-lv-sig" to sig))
        return r.getJSONObject("sessionDescription").getString("sdp")
    }

    /** Tells the presenter page what we're publishing. Returns true when asked to stop. */
    fun heartbeat(screenTrack: String, micTrack: String?): Boolean {
        val body = JSONObject()
            .put("action", "cast-start")
            .put("token", token)
            .put("screen", JSONObject().put("sessionId", sessionId).put("trackName", screenTrack))
        if (micTrack != null) body.put("mic", JSONObject().put("sessionId", sessionId).put("trackName", micTrack))
        return call("", "POST", body).optBoolean("stop")
    }

    fun stopped() {
        call("", "POST", JSONObject().put("action", "cast-stop").put("token", token).put("fromApp", true))
    }
}
