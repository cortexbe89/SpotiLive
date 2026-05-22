import { useState, useEffect, useCallback, useRef } from "react";

// ─── SPOTIFY CONFIG ────────────────────────────────────────────────────────────
const SPOTIFY_CLIENT_ID = "80383eb1983d4282b296c26b91b75b6d";
const SPOTIFY_CLIENT_ID_KEY = "spotilive_client_id";
const SPOTIFY_SCOPES = [
  "user-read-currently-playing",
  "user-read-playback-state",
  "user-read-recently-played",
  "user-top-read",
].join(" ");

// ─── PKCE HELPERS ──────────────────────────────────────────────────────────────
function generateCodeVerifier(length = 128) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const arr = new Uint8Array(length);
  crypto.getRandomValues(arr);
  return Array.from(arr, (b) => chars[b % chars.length]).join("");
}
async function generateCodeChallenge(verifier) {
  const enc = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// ─── LAST.FM ───────────────────────────────────────────────────────────────────
const LASTFM_API = "https://ws.audioscrobbler.com/2.0/";

async function lastfmFetch(params) {
  const url = new URL(LASTFM_API);
  Object.entries({ ...params, format: "json" }).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url);
  return res.json();
}

// ─── UTILS ─────────────────────────────────────────────────────────────────────
function msToTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function fmtNum(n) {
  if (!n) return "—";
  return Number(n).toLocaleString("fr-BE");
}

// ─── MAIN APP ──────────────────────────────────────────────────────────────────
export default function SpotiLive() {
  // Auth & config
  const [clientId, setClientId] = useState(SPOTIFY_CLIENT_ID);
  const [clientIdInput, setClientIdInput] = useState("");
  const [lastfmKey, setLastfmKey] = useState(() => localStorage.getItem("spotilive_lastfm_key") || "");
  const [lastfmKeyInput, setLastfmKeyInput] = useState("");
  const [lastfmUser, setLastfmUser] = useState(() => localStorage.getItem("spotilive_lastfm_user") || "");
  const [lastfmUserInput, setLastfmUserInput] = useState("");
  const [token, setToken] = useState(null);
  const [showConfig, setShowConfig] = useState(false);

  // Playback
  const [current, setCurrent] = useState(null);
  const [progress, setProgress] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  // Stats
  const [trackStats, setTrackStats] = useState(null);
  const [artistStats, setArtistStats] = useState(null);
  const [topTracks, setTopTracks] = useState([]);
  const [topArtists, setTopArtists] = useState([]);
  const [recentTracks, setRecentTracks] = useState([]);
  const [lastfmProfile, setLastfmProfile] = useState(null);
  const [lastfmNowPlaying, setLastfmNowPlaying] = useState(null);

  // AI content
  const [aiContent, setAiContent] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);

  // UI
  const [activeTab, setActiveTab] = useState("now");
  const pollRef = useRef(null);
  const lastTrackRef = useRef(null);
  const progressRef = useRef(null);

  // ── OAuth PKCE ────────────────────────────────────────────────────────────
  const handleSpotifyLogin = async () => {
    const id = SPOTIFY_CLIENT_ID;
    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    sessionStorage.setItem("pkce_verifier", verifier);
    const redirectUri = window.location.href.split("?")[0].split("#")[0];
    sessionStorage.setItem("pkce_redirect", redirectUri);
    const params = new URLSearchParams({
      client_id: id,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SPOTIFY_SCOPES,
      code_challenge_method: "S256",
      code_challenge: challenge,
    });
    window.location.href = "https://accounts.spotify.com/authorize?" + params;
  };

  // ── Token exchange after redirect ─────────────────────────────────────────
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const verifier = sessionStorage.getItem("pkce_verifier");
    const redirectUri = sessionStorage.getItem("pkce_redirect");
    const id = SPOTIFY_CLIENT_ID;
    if (code && verifier) {
      window.history.replaceState({}, "", window.location.pathname);
      fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: redirectUri,
          client_id: id,
          code_verifier: verifier,
        }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.access_token) {
            setToken(data.access_token);
            sessionStorage.setItem("spotify_token", data.access_token);
            sessionStorage.removeItem("pkce_verifier");
          }
        });
    } else {
      const saved = sessionStorage.getItem("spotify_token");
      if (saved) setToken(saved);
    }
  }, []);

  // ── Spotify API ───────────────────────────────────────────────────────────
  const spotifyFetch = useCallback(async (path) => {
    if (!token) return null;
    const res = await fetch(`https://api.spotify.com/v1/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) { setToken(null); sessionStorage.removeItem("spotify_token"); return null; }
    if (res.status === 204 || res.status === 202) return null;
    return res.json();
  }, [token]);

  // ── Fetch current track ───────────────────────────────────────────────────
  const fetchCurrent = useCallback(async () => {
    const data = await spotifyFetch("me/player/currently-playing");
    if (!data || !data.item) { setCurrent(null); setIsPlaying(false); return; }
    setIsPlaying(data.is_playing);
    setProgress(data.progress_ms || 0);
    const track = data.item;
    setCurrent(track);
    if (track.id !== lastTrackRef.current) {
      lastTrackRef.current = track.id;
      fetchTrackStats(track);
      fetchArtistStats(track.artists[0]);
      generateAiContent(track);
    }
  }, [spotifyFetch]);

  // ── Fetch track stats (Spotify audio features + Last.fm) ──────────────────
  const fetchTrackStats = async (track) => {
    const feat = await spotifyFetch(`audio-features/${track.id}`);
    let lfm = null;
    if (lastfmKey) {
      lfm = await lastfmFetch({
        method: "track.getInfo",
        api_key: lastfmKey,
        artist: track.artists[0].name,
        track: track.name,
        username: lastfmUser || undefined,
      });
    }
    setTrackStats({ spotify: feat, lastfm: lfm?.track });
  };

  const fetchArtistStats = async (artist) => {
    const data = await spotifyFetch(`artists/${artist.id}`);
    let lfm = null;
    if (lastfmKey) {
      lfm = await lastfmFetch({
        method: "artist.getInfo",
        api_key: lastfmKey,
        artist: artist.name,
        lang: "fr",
      });
    }
    setArtistStats({ spotify: data, lastfm: lfm?.artist });
  };

  // ── Last.fm profile & listening stats ─────────────────────────────────────
  const fetchLastfmStats = useCallback(async () => {
    if (!lastfmKey || !lastfmUser) return;
    const [profile, recent, nowPlaying] = await Promise.all([
      lastfmFetch({ method: "user.getInfo", api_key: lastfmKey, user: lastfmUser }),
      lastfmFetch({ method: "user.getRecentTracks", api_key: lastfmKey, user: lastfmUser, limit: 10 }),
      lastfmFetch({ method: "user.getRecentTracks", api_key: lastfmKey, user: lastfmUser, limit: 1 }),
    ]);
    setLastfmProfile(profile?.user);
    const tracks = recent?.recenttracks?.track || [];
    setRecentTracks(Array.isArray(tracks) ? tracks.slice(0, 10) : [tracks]);
    const np = nowPlaying?.recenttracks?.track?.[0];
    setLastfmNowPlaying(np?.["@attr"]?.nowplaying === "true" ? np : null);
  }, [lastfmKey, lastfmUser]);

  const fetchSpotifyStats = useCallback(async () => {
    const [top4w, topArt] = await Promise.all([
      spotifyFetch("me/top/tracks?time_range=short_term&limit=10"),
      spotifyFetch("me/top/artists?time_range=short_term&limit=8"),
    ]);
    if (top4w?.items) setTopTracks(top4w.items);
    if (topArt?.items) setTopArtists(topArt.items);
  }, [spotifyFetch]);

  // ── Traduction MyMemory (gratuit, sans clé) ──────────────────────────────
  const translateToFr = async (text) => {
    if (!text || text.length < 10) return text;
    const frenchPattern = /[àâäéèêëîïôöùûüçœæ]/i;
    if (frenchPattern.test(text)) return text;
    try {
      const res = await fetch(
        `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text.slice(0, 500))}&langpair=en|fr`
      );
      const data = await res.json();
      if (data.responseStatus === 200 && data.responseData?.translatedText) {
        return data.responseData.translatedText;
      }
    } catch {}
    return text;
  };

  // ── Enrichissement via Last.fm + MusicBrainz (gratuit, sans clé) ────────────
  const generateAiContent = async (track) => {
    setAiContent(null);
    setAiLoading(true);
    try {
      const artistName = track.artists[0].name;
      const trackName = track.name;

      const [lfmArtist, lfmTrack] = await Promise.all([
        lastfmKey
          ? lastfmFetch({ method: "artist.getInfo", api_key: lastfmKey, artist: artistName, lang: "fr" })
          : fetch(`https://ws.audioscrobbler.com/2.0/?method=artist.getInfo&artist=${encodeURIComponent(artistName)}&lang=fr&api_key=43a8dd6083e2571bf6e47c5d88a88a7f&format=json`).then(r=>r.json()),
        lastfmKey
          ? lastfmFetch({ method: "track.getInfo", api_key: lastfmKey, artist: artistName, track: trackName })
          : fetch(`https://ws.audioscrobbler.com/2.0/?method=track.getInfo&artist=${encodeURIComponent(artistName)}&track=${encodeURIComponent(trackName)}&api_key=43a8dd6083e2571bf6e47c5d88a88a7f&format=json`).then(r=>r.json()),
      ]);

      const mbRes = await fetch(
        `https://musicbrainz.org/ws/2/recording/?query=recording:"${encodeURIComponent(trackName)}" AND artist:"${encodeURIComponent(artistName)}"&limit=1&fmt=json`,
        { headers: { "User-Agent": "SpotiLive/1.0 (https://spotilive.netlify.app)" } }
      );
      const mbData = await mbRes.json();
      const mbRecording = mbData?.recordings?.[0];

      let bio = lfmArtist?.artist?.bio?.summary || "";
      bio = bio.replace(/<a[^>]*>[\s\S]*?<\/a>/gi, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      bio = bio.split(".").slice(0, 4).join(".").trim();
      if (bio) bio = await translateToFr(bio);
      if (!bio) bio = "Biographie non disponible pour cet artiste.";

      const tags = lfmArtist?.artist?.tags?.tag?.map(t => t.name) || [];
      const genre = tags[0] || lfmTrack?.track?.toptags?.tag?.[0]?.name || "—";
      const ambiance = tags.slice(1, 3).join(", ") || "—";

      let explication = lfmTrack?.track?.wiki?.summary || lfmArtist?.artist?.bio?.content || "";
      explication = explication.replace(/<a[^>]*>[\s\S]*?<\/a>/gi, "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      explication = explication.split(".").slice(0, 3).join(".").trim();
      if (explication) explication = await translateToFr(explication);
      if (!explication) {
        const yr = track.album.release_date?.slice(0, 4);
        explication = `"${trackName}" est un titre de ${artistName}${yr ? `, sorti en ${yr}` : ""}, extrait de l'album "${track.album.name}".`;
      }

      const anecdotes = [];
      if (mbRecording) {
        if (mbRecording.length) anecdotes.push(`Durée officielle : ${Math.floor(mbRecording.length/60000)}m${String(Math.floor((mbRecording.length%60000)/1000)).padStart(2,"0")}s.`);
        if (mbRecording.releases?.[0]?.date) anecdotes.push(`Date de sortie officielle : ${mbRecording.releases[0].date}.`);
        if (mbRecording.releases?.[0]?.country) anecdotes.push(`Pays de sortie : ${mbRecording.releases[0].country}.`);
      }
      if (lfmTrack?.track?.playcount) anecdotes.push(`Ce titre totalise ${Number(lfmTrack.track.playcount).toLocaleString("fr-BE")} écoutes sur Last.fm.`);
      if (lfmArtist?.artist?.stats?.listeners) anecdotes.push(`${Number(lfmArtist.artist.stats.listeners).toLocaleString("fr-BE")} auditeurs uniques sur Last.fm.`);

      setAiContent({ bio, explication, anecdotes, genre, ambiance });
    } catch (e) {
      setAiContent({ bio: "Données indisponibles.", explication: "", anecdotes: [], genre: "—", ambiance: "—" });
    }
    setAiLoading(false);
  };

  // ── Polling ───────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!token) return;
    fetchCurrent();
    fetchSpotifyStats();
    fetchLastfmStats();
    pollRef.current = setInterval(() => {
      fetchCurrent();
      fetchLastfmStats();
    }, 15000);
    return () => clearInterval(pollRef.current);
  }, [token, fetchCurrent, fetchSpotifyStats, fetchLastfmStats]);

  // ── Progress bar animation ─────────────────────────────────────────────────
  useEffect(() => {
    if (!isPlaying || !current) return;
    progressRef.current = setInterval(() => {
      setProgress(p => Math.min(p + 1000, current.duration_ms));
    }, 1000);
    return () => clearInterval(progressRef.current);
  }, [isPlaying, current]);

  // ── Save config ───────────────────────────────────────────────────────────
  const saveConfig = () => {
    if (clientIdInput) { localStorage.setItem(SPOTIFY_CLIENT_ID_KEY, clientIdInput); setClientId(clientIdInput); }
    if (lastfmKeyInput) { localStorage.setItem("spotilive_lastfm_key", lastfmKeyInput); setLastfmKey(lastfmKeyInput); }
    if (lastfmUserInput) { localStorage.setItem("spotilive_lastfm_user", lastfmUserInput); setLastfmUser(lastfmUserInput); }
    setShowConfig(false);
  };

  // ── Logout ────────────────────────────────────────────────────────────────
  const logout = () => {
    setToken(null);
    sessionStorage.removeItem("spotify_token");
    setCurrent(null);
    setAiContent(null);
    setTrackStats(null);
  };

  const pct = current ? (progress / current.duration_ms) * 100 : 0;

  // ─────────────────────────────────────────────────────────────────────────
  // RENDER: LOGIN SCREEN
  // ─────────────────────────────────────────────────────────────────────────
  if (!token) {
    return (
      <div style={styles.configScreen}>
        <div style={styles.configCard}>
          <div style={styles.logo}>SpotiLive</div>
          <p style={styles.configSubtitle}>Votre musique, enrichie en temps réel</p>

          <button style={styles.btnSpotify} onClick={handleSpotifyLogin}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="white" style={{ marginRight: 10 }}>
              <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
            </svg>
            Se connecter avec Spotify
          </button>

          <div style={styles.divider}><span style={styles.dividerText}>Last.fm (optionnel)</span></div>

          <div style={styles.configSection}>
            <input
              style={styles.configInput}
              placeholder="Clé API Last.fm"
              value={lastfmKeyInput}
              onChange={e => setLastfmKeyInput(e.target.value)}
            />
            <input
              style={{ ...styles.configInput, marginTop: 8 }}
              placeholder="Username Last.fm"
              value={lastfmUserInput}
              onChange={e => setLastfmUserInput(e.target.value)}
            />
            {(lastfmKeyInput || lastfmUserInput) && (
              <button style={{ ...styles.btnPrimary, marginTop: 8 }} onClick={() => {
                if (lastfmKeyInput) { localStorage.setItem("spotilive_lastfm_key", lastfmKeyInput); setLastfmKey(lastfmKeyInput); }
                if (lastfmUserInput) { localStorage.setItem("spotilive_lastfm_user", lastfmUserInput); setLastfmUser(lastfmUserInput); }
              }}>
                Sauvegarder Last.fm
              </button>
            )}
            <a href="https://www.last.fm/api/account/create" target="_blank" rel="noreferrer" style={styles.configLink}>
              → Obtenir une clé API Last.fm (gratuit)
            </a>
          </div>
        </div>
      </div>
    );
  }


  // ─────────────────────────────────────────────────────────────────────────
  // RENDER: MAIN APP
  // ─────────────────────────────────────────────────────────────────────────
  return (
    <div style={styles.app}>
      {/* Ambient background from album art */}
      {current?.album?.images?.[0]?.url && (
        <div style={{ ...styles.ambientBg, backgroundImage: `url(${current.album.images[0].url})` }} />
      )}
      <div style={styles.overlay} />

      {/* Header */}
      <header style={styles.header}>
        <div style={styles.headerLogo}>SpotiLive</div>
        <div style={styles.headerRight}>
          {lastfmProfile && (
            <span style={styles.lfmBadge}>
              📻 {lastfmProfile.name} · {fmtNum(lastfmProfile.playcount)} écoutes
            </span>
          )}
          <button style={styles.btnIcon} onClick={() => setShowConfig(true)} title="Configuration">⚙</button>
          <button style={styles.btnIcon} onClick={logout} title="Déconnexion">✕</button>
        </div>
      </header>

      {/* Tabs */}
      <nav style={styles.tabs}>
        {["now", "stats", "history"].map(tab => (
          <button
            key={tab}
            style={{ ...styles.tab, ...(activeTab === tab ? styles.tabActive : {}) }}
            onClick={() => setActiveTab(tab)}
          >
            {{ now: "En cours", stats: "Statistiques", history: "Historique" }[tab]}
          </button>
        ))}
      </nav>

      <main style={styles.main}>

        {/* ── NOW PLAYING ── */}
        {activeTab === "now" && (
          <div style={styles.nowGrid}>
            {/* Left: Player */}
            <div style={styles.playerCol}>
              {current ? (
                <>
                  <div style={styles.albumWrap}>
                    <img src={current.album.images[0]?.url} alt="Album" style={styles.albumArt} />
                    {isPlaying && <div style={styles.playingRing} />}
                  </div>
                  <div style={styles.trackInfo}>
                    <h1 style={styles.trackName}>{current.name}</h1>
                    <p style={styles.artistName}>{current.artists.map(a => a.name).join(", ")}</p>
                    <p style={styles.albumName}>{current.album.name} · {current.album.release_date?.slice(0, 4)}</p>
                  </div>
                  {/* Progress */}
                  <div style={styles.progressWrap}>
                    <span style={styles.timeLabel}>{msToTime(progress)}</span>
                    <div style={styles.progressBar}>
                      <div style={{ ...styles.progressFill, width: `${pct}%` }} />
                    </div>
                    <span style={styles.timeLabel}>{msToTime(current.duration_ms)}</span>
                  </div>
                  {/* Quick stats row */}
                  <div style={styles.quickStats}>
                    {[
                      ["Popularité", current.popularity ? `${current.popularity}/100` : "—"],
                      ["Écoutes", trackStats?.lastfm?.playcount ? fmtNum(trackStats.lastfm.playcount) : "—"],
                      ["Genre", aiContent?.genre || "—"],
                      ["Ambiance", aiContent?.ambiance || "—"],
                    ].map(([k, v]) => (
                      <div key={k} style={styles.quickStat}>
                        <span style={styles.qsLabel}>{k}</span>
                        <span style={styles.qsValue}>{v}</span>
                      </div>
                    ))}
                  </div>
                  {/* Popularity bar */}
                  {current.popularity > 0 && (
                    <div style={styles.popWrap}>
                      <span style={styles.popLabel}>Popularité Spotify</span>
                      <div style={styles.popBar}>
                        <div style={{ ...styles.popFill, width: `${current.popularity}%` }} />
                      </div>
                    </div>
                  )}
                </>
              ) : (
                <div style={styles.nothing}>
                  <div style={styles.nothingIcon}>♪</div>
                  <p>Aucune lecture en cours</p>
                  <p style={{ opacity: 0.5, fontSize: 13 }}>Lancez Spotify pour voir apparaître votre musique ici</p>
                </div>
              )}
            </div>

            {/* Right: AI Content */}
            <div style={styles.aiCol}>
              {aiLoading ? (
                <div style={styles.aiLoading}>
                  <div style={styles.aiSpinner} />
                  <p>Analyse en cours…</p>
                </div>
              ) : aiContent ? (
                <>
                  <div style={styles.aiBlock}>
                    <h3 style={styles.aiTitle}>Biographie</h3>
                    <p style={styles.aiText}>{aiContent.bio}</p>
                  </div>
                  <div style={styles.aiBlock}>
                    <h3 style={styles.aiTitle}>La chanson</h3>
                    <p style={styles.aiText}>{aiContent.explication}</p>
                  </div>
                  {aiContent.anecdotes?.length > 0 && (
                    <div style={styles.aiBlock}>
                      <h3 style={styles.aiTitle}>Anecdotes</h3>
                      <ul style={styles.anecdoteList}>
                        {aiContent.anecdotes.map((a, i) => (
                          <li key={i} style={styles.anecdoteItem}>
                            <span style={styles.anecdoteDot}>✦</span>
                            {a}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {/* Last.fm track stats */}
                  {trackStats?.lastfm && (
                    <div style={styles.aiBlock}>
                      <h3 style={styles.aiTitle}>Données Last.fm</h3>
                      <div style={styles.lfmGrid}>
                        <div style={styles.lfmStat}><span style={styles.lfmVal}>{fmtNum(trackStats.lastfm.playcount)}</span><span style={styles.lfmLbl}>écoutes globales</span></div>
                        <div style={styles.lfmStat}><span style={styles.lfmVal}>{fmtNum(trackStats.lastfm.listeners)}</span><span style={styles.lfmLbl}>auditeurs</span></div>
                        {trackStats.lastfm.userplaycount && <div style={styles.lfmStat}><span style={styles.lfmVal}>{fmtNum(trackStats.lastfm.userplaycount)}</span><span style={styles.lfmLbl}>vos écoutes</span></div>}
                      </div>
                      {trackStats.lastfm.toptags?.tag?.length > 0 && (
                        <div style={styles.tagsRow}>
                          {trackStats.lastfm.toptags.tag.slice(0, 5).map(t => (
                            <span key={t.name} style={styles.tag}>{t.name}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                  {/* Artiste Last.fm */}
                  {artistStats?.lastfm && (
                    <div style={styles.aiBlock}>
                      <h3 style={styles.aiTitle}>Artiste · Last.fm</h3>
                      <div style={styles.lfmGrid}>
                        <div style={styles.lfmStat}><span style={styles.lfmVal}>{fmtNum(artistStats.lastfm.stats?.playcount)}</span><span style={styles.lfmLbl}>écoutes</span></div>
                        <div style={styles.lfmStat}><span style={styles.lfmVal}>{fmtNum(artistStats.lastfm.stats?.listeners)}</span><span style={styles.lfmLbl}>auditeurs</span></div>
                      </div>
                    </div>
                  )}
                </>
              ) : !current ? (
                <div style={styles.aiPlaceholder}>
                  <p>Les informations sur la chanson apparaîtront ici</p>
                </div>
              ) : null}
            </div>
          </div>
        )}

        {/* ── STATS ── */}
        {activeTab === "stats" && (
          <div style={styles.statsGrid}>
            {/* Last.fm profile */}
            {lastfmProfile && (
              <div style={styles.statCard}>
                <h3 style={styles.cardTitle}>📻 Profil Last.fm</h3>
                <div style={styles.profileRow}>
                  {lastfmProfile.image?.[2]?.["#text"] && (
                    <img src={lastfmProfile.image[2]["#text"]} alt="Avatar" style={styles.avatar} />
                  )}
                  <div>
                    <p style={styles.profileName}>{lastfmProfile.name}</p>
                    <p style={styles.profileSub}>{fmtNum(lastfmProfile.playcount)} écoutes au total</p>
                    <p style={styles.profileSub}>Membre depuis {new Date(lastfmProfile.registered?.unixtime * 1000).getFullYear()}</p>
                    {lastfmProfile.country && <p style={styles.profileSub}>📍 {lastfmProfile.country}</p>}
                  </div>
                </div>
              </div>
            )}

            {/* Top Tracks 4 semaines */}
            {topTracks.length > 0 && (
              <div style={styles.statCard}>
                <h3 style={styles.cardTitle}>🔥 Top titres · 4 semaines</h3>
                <ol style={styles.rankList}>
                  {topTracks.map((t, i) => (
                    <li key={t.id} style={styles.rankItem}>
                      <span style={styles.rankNum}>{i + 1}</span>
                      {t.album?.images?.[2]?.url && <img src={t.album.images[2].url} alt="" style={styles.rankThumb} />}
                      <div style={styles.rankInfo}>
                        <span style={styles.rankTitle}>{t.name}</span>
                        <span style={styles.rankSub}>{t.artists[0].name}</span>
                      </div>
                      <span style={styles.rankPop}>{t.popularity}</span>
                    </li>
                  ))}
                </ol>
              </div>
            )}

            {/* Top Artists */}
            {topArtists.length > 0 && (
              <div style={styles.statCard}>
                <h3 style={styles.cardTitle}>⭐ Top artistes · 4 semaines</h3>
                <div style={styles.artistsGrid}>
                  {topArtists.map((a, i) => (
                    <div key={a.id} style={styles.artistChip}>
                      {a.images?.[2]?.url && <img src={a.images[2].url} alt="" style={styles.artistThumb} />}
                      <div>
                        <p style={styles.artistChipName}>{a.name}</p>
                        <p style={styles.artistChipSub}>{a.genres?.[0] || "—"}</p>
                      </div>
                      <span style={styles.rankNumSm}>{i + 1}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── HISTORY ── */}
        {activeTab === "history" && (
          <div style={styles.historyWrap}>
            <h3 style={styles.cardTitle}>🕐 Dernières écoutes · Last.fm</h3>
            {recentTracks.length === 0 ? (
              <p style={{ opacity: 0.5 }}>Aucune donnée Last.fm. Configurez votre clé et username Last.fm.</p>
            ) : (
              <div style={styles.historyList}>
                {recentTracks.map((t, i) => (
                  <div key={i} style={styles.historyItem}>
                    {t.image?.[1]?.["#text"] && <img src={t.image[1]["#text"]} alt="" style={styles.historyThumb} />}
                    <div style={styles.historyInfo}>
                      <span style={styles.historyTitle}>{t.name}</span>
                      <span style={styles.historySub}>{t.artist?.["#text"] || t.artist?.name} · {t.album?.["#text"]}</span>
                    </div>
                    <span style={styles.historyTime}>
                      {t["@attr"]?.nowplaying ? "▶ En cours" : t.date?.["#text"] ? t.date["#text"].slice(0, -6) : ""}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {/* Config Modal */}
      {showConfig && (
        <div style={styles.modalOverlay} onClick={() => setShowConfig(false)}>
          <div style={styles.modal} onClick={e => e.stopPropagation()}>
            <h2 style={styles.modalTitle}>Configuration</h2>
            <div style={styles.configSection}>
              <label style={styles.configLabel}>Spotify Client ID</label>
              <input style={styles.configInput} placeholder={clientId ? "••••••••••••" : "Client ID"} value={clientIdInput} onChange={e => setClientIdInput(e.target.value)} />
            </div>
            <div style={styles.configSection}>
              <label style={styles.configLabel}>Last.fm API Key</label>
              <input style={styles.configInput} placeholder={lastfmKey ? "••••••••••••" : "API Key"} value={lastfmKeyInput} onChange={e => setLastfmKeyInput(e.target.value)} />
              <label style={{ ...styles.configLabel, marginTop: 8 }}>Last.fm Username</label>
              <input style={styles.configInput} placeholder={lastfmUser || "Username"} value={lastfmUserInput} onChange={e => setLastfmUserInput(e.target.value)} />
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
              <button style={styles.btnPrimary} onClick={saveConfig}>Sauvegarder</button>
              <button style={styles.btnSecondary} onClick={() => setShowConfig(false)}>Annuler</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,600;1,9..144,300&family=DM+Mono:wght@300;400&display=swap');
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100%{opacity:1;transform:scale(1)} 50%{opacity:.5;transform:scale(1.05)} }
        @keyframes ring { 0%{transform:scale(1);opacity:.8} 100%{transform:scale(1.15);opacity:0} }
        * { box-sizing: border-box; margin: 0; padding: 0; }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-track { background: transparent; } ::-webkit-scrollbar-thumb { background: rgba(255,255,255,.2); border-radius: 2px; }
      `}</style>
    </div>
  );
}

// ─── STYLES ────────────────────────────────────────────────────────────────────
const styles = {
  app: {
    minHeight: "100vh",
    background: "#0a0a0f",
    color: "#f0ede8",
    fontFamily: "'DM Mono', monospace",
    position: "relative",
    overflow: "hidden",
  },
  ambientBg: {
    position: "fixed", inset: 0,
    backgroundSize: "cover", backgroundPosition: "center",
    filter: "blur(80px) saturate(1.8)",
    opacity: 0.12,
    transform: "scale(1.1)",
    transition: "background-image 2s ease",
    zIndex: 0,
  },
  overlay: {
    position: "fixed", inset: 0,
    background: "linear-gradient(180deg, rgba(10,10,15,.95) 0%, rgba(10,10,15,.85) 100%)",
    zIndex: 1,
  },
  header: {
    position: "relative", zIndex: 10,
    display: "flex", alignItems: "center", justifyContent: "space-between",
    padding: "14px 16px",
    borderBottom: "1px solid rgba(255,255,255,.06)",
    backdropFilter: "blur(20px)",
  },
  headerLogo: {
    fontFamily: "'Fraunces', serif",
    fontSize: 22, fontWeight: 600,
    letterSpacing: "-0.5px",
    background: "linear-gradient(135deg, #1db954, #1ed760)",
    WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
  },
  headerRight: { display: "flex", alignItems: "center", gap: 12 },
  lfmBadge: {
    fontSize: 11, opacity: 0.6,
    background: "rgba(255,255,255,.06)",
    padding: "5px 10px", borderRadius: 20,
  },
  btnIcon: {
    background: "rgba(255,255,255,.08)", border: "none",
    color: "#f0ede8", cursor: "pointer",
    width: 32, height: 32, borderRadius: "50%",
    fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center",
  },
  tabs: {
    position: "relative", zIndex: 10,
    display: "flex", gap: 4, padding: "12px 28px 0",
  },
  tab: {
    background: "none", border: "none", color: "rgba(240,237,232,.4)",
    cursor: "pointer", fontSize: 13,
    padding: "8px 16px", borderRadius: "8px 8px 0 0",
    fontFamily: "'DM Mono', monospace",
    transition: "all .2s",
  },
  tabActive: {
    background: "rgba(255,255,255,.06)",
    color: "#f0ede8",
    borderBottom: "2px solid #1db954",
  },
  main: {
    position: "relative", zIndex: 10,
    padding: "16px",
    maxWidth: 1200, margin: "0 auto",
  },
  // NOW PLAYING
  nowGrid: {
    display: "flex",
    flexDirection: "column",
    gap: 20,
    maxWidth: 600,
    margin: "0 auto",
    width: "100%",
  },
  playerCol: {
    display: "flex", flexDirection: "column", gap: 16,
    alignItems: "center",
  },
  albumWrap: {
    position: "relative", alignSelf: "center",
    width: 220, height: 220,
  },
  albumArt: {
    width: "100%", height: "100%",
    borderRadius: 16,
    boxShadow: "0 20px 60px rgba(0,0,0,.6)",
    position: "relative", zIndex: 2,
  },
  playingRing: {
    position: "absolute", inset: -8,
    border: "2px solid #1db954",
    borderRadius: 24,
    animation: "ring 2s ease-out infinite",
    zIndex: 1,
  },
  trackInfo: { textAlign: "center", width: "100%" },
  trackName: {
    fontFamily: "'Fraunces', serif",
    fontSize: 22, fontWeight: 600,
    lineHeight: 1.2, marginBottom: 6,
  },
  artistName: { fontSize: 15, opacity: 0.8, marginBottom: 4 },
  albumName: { fontSize: 12, opacity: 0.45 },
  progressWrap: {
    display: "flex", alignItems: "center", gap: 8,
    width: "100%",
  },
  progressBar: {
    flex: 1, height: 3,
    background: "rgba(255,255,255,.12)",
    borderRadius: 2, overflow: "hidden",
  },
  progressFill: {
    height: "100%",
    background: "linear-gradient(90deg, #1db954, #1ed760)",
    borderRadius: 2,
    transition: "width 1s linear",
  },
  timeLabel: { fontSize: 11, opacity: 0.45, fontVariantNumeric: "tabular-nums" },
  quickStats: {
    display: "grid", gridTemplateColumns: "1fr 1fr",
    gap: 8, width: "100%",
  },
  quickStat: {
    background: "rgba(255,255,255,.04)",
    borderRadius: 10, padding: "10px 14px",
    display: "flex", flexDirection: "column", gap: 3,
  },
  qsLabel: { fontSize: 10, opacity: 0.4, textTransform: "uppercase", letterSpacing: 1 },
  qsValue: { fontSize: 14, fontWeight: 500 },
  popWrap: { display: "flex", flexDirection: "column", gap: 6 },
  popLabel: { fontSize: 10, opacity: 0.4, textTransform: "uppercase", letterSpacing: 1 },
  popBar: {
    height: 4, background: "rgba(255,255,255,.08)",
    borderRadius: 2, overflow: "hidden",
  },
  popFill: {
    height: "100%",
    background: "linear-gradient(90deg, #1db954, #1ed760)",
    borderRadius: 2,
  },
  nothing: {
    textAlign: "center", opacity: 0.4,
    padding: "60px 20px", display: "flex",
    flexDirection: "column", gap: 12, alignItems: "center",
  },
  nothingIcon: { fontSize: 48 },
  // AI COL
  aiCol: {
    display: "flex", flexDirection: "column", gap: 14,
    width: "100%",
  },
  aiLoading: {
    display: "flex", flexDirection: "column", alignItems: "center",
    gap: 16, padding: 60, opacity: 0.5,
  },
  aiSpinner: {
    width: 28, height: 28,
    border: "2px solid rgba(255,255,255,.2)",
    borderTopColor: "#1db954",
    borderRadius: "50%",
    animation: "spin 1s linear infinite",
  },
  aiBlock: {
    background: "rgba(255,255,255,.04)",
    borderRadius: 14, padding: "18px 20px",
    border: "1px solid rgba(255,255,255,.06)",
  },
  aiTitle: {
    fontSize: 10, fontWeight: 400,
    textTransform: "uppercase", letterSpacing: 2,
    opacity: 0.4, marginBottom: 10, color: "#1db954",
  },
  aiText: { fontSize: 14, lineHeight: 1.7, opacity: 0.85 },
  anecdoteList: { listStyle: "none", display: "flex", flexDirection: "column", gap: 10 },
  anecdoteItem: {
    display: "flex", gap: 10, fontSize: 13, lineHeight: 1.6, opacity: 0.8,
  },
  anecdoteDot: { color: "#1db954", flexShrink: 0, marginTop: 2 },
  lfmGrid: { display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 10 },
  lfmStat: { display: "flex", flexDirection: "column", gap: 2 },
  lfmVal: { fontSize: 18, fontFamily: "'Fraunces', serif", fontWeight: 600 },
  lfmLbl: { fontSize: 10, opacity: 0.4 },
  tagsRow: { display: "flex", flexWrap: "wrap", gap: 6 },
  tag: {
    fontSize: 11, padding: "3px 8px",
    background: "rgba(29,185,84,.12)",
    color: "#1db954", borderRadius: 20,
  },
  aiPlaceholder: {
    padding: 40, textAlign: "center",
    opacity: 0.3, fontSize: 13,
  },
  // STATS
  statsGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
    gap: 20,
  },
  statCard: {
    background: "rgba(255,255,255,.04)",
    borderRadius: 16, padding: "20px",
    border: "1px solid rgba(255,255,255,.06)",
  },
  cardTitle: {
    fontSize: 13, fontWeight: 400,
    marginBottom: 16, opacity: 0.7,
    fontFamily: "'Fraunces', serif",
  },
  profileRow: { display: "flex", gap: 14, alignItems: "center" },
  avatar: { width: 52, height: 52, borderRadius: "50%" },
  profileName: { fontSize: 16, fontWeight: 600, marginBottom: 4 },
  profileSub: { fontSize: 12, opacity: 0.5, lineHeight: 1.8 },
  rankList: { listStyle: "none", display: "flex", flexDirection: "column", gap: 8 },
  rankItem: {
    display: "flex", alignItems: "center", gap: 10,
    padding: "6px 0",
    borderBottom: "1px solid rgba(255,255,255,.04)",
  },
  rankNum: { fontSize: 11, opacity: 0.3, width: 18, textAlign: "right" },
  rankThumb: { width: 36, height: 36, borderRadius: 6 },
  rankInfo: { flex: 1, minWidth: 0 },
  rankTitle: { display: "block", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  rankSub: { display: "block", fontSize: 11, opacity: 0.4 },
  rankPop: { fontSize: 11, opacity: 0.35, fontVariantNumeric: "tabular-nums" },
  artistsGrid: { display: "flex", flexDirection: "column", gap: 8 },
  artistChip: {
    display: "flex", alignItems: "center", gap: 10,
    padding: "6px 0",
    borderBottom: "1px solid rgba(255,255,255,.04)",
  },
  artistThumb: { width: 38, height: 38, borderRadius: "50%" },
  artistChipName: { fontSize: 13 },
  artistChipSub: { fontSize: 11, opacity: 0.4 },
  rankNumSm: { fontSize: 11, opacity: 0.25, marginLeft: "auto" },
  // HISTORY
  historyWrap: {
    background: "rgba(255,255,255,.04)",
    borderRadius: 16, padding: "20px",
    border: "1px solid rgba(255,255,255,.06)",
  },
  historyList: { display: "flex", flexDirection: "column", gap: 2, marginTop: 12 },
  historyItem: {
    display: "flex", alignItems: "center", gap: 12,
    padding: "10px 0",
    borderBottom: "1px solid rgba(255,255,255,.04)",
  },
  historyThumb: { width: 40, height: 40, borderRadius: 6, flexShrink: 0 },
  historyInfo: { flex: 1, minWidth: 0 },
  historyTitle: { display: "block", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  historySub: { display: "block", fontSize: 11, opacity: 0.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  historyTime: { fontSize: 11, opacity: 0.35, flexShrink: 0 },
  // CONFIG SCREEN
  configScreen: {
    minHeight: "100vh",
    background: "#0a0a0f",
    display: "flex", alignItems: "center", justifyContent: "center",
    fontFamily: "'DM Mono', monospace",
  },
  configCard: {
    background: "rgba(255,255,255,.04)",
    border: "1px solid rgba(255,255,255,.08)",
    borderRadius: 20, padding: "40px",
    maxWidth: 480, width: "90%",
    display: "flex", flexDirection: "column", gap: 24,
  },
  logo: {
    fontFamily: "'Fraunces', serif",
    fontSize: 32, fontWeight: 600,
    background: "linear-gradient(135deg, #1db954, #1ed760)",
    WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent",
    textAlign: "center",
  },
  configSubtitle: { textAlign: "center", opacity: 0.5, fontSize: 13, color: "#f0ede8" },
  configSection: { display: "flex", flexDirection: "column", gap: 6 },
  configLabel: { fontSize: 12, opacity: 0.6, color: "#f0ede8" },
  optional: { fontSize: 10, opacity: 0.4, marginLeft: 6 },
  configInput: {
    background: "rgba(255,255,255,.06)",
    border: "1px solid rgba(255,255,255,.12)",
    borderRadius: 10, padding: "12px 14px",
    color: "#f0ede8", fontSize: 13,
    fontFamily: "'DM Mono', monospace",
    outline: "none",
  },
  configLink: { fontSize: 12, color: "#1db954", textDecoration: "none", opacity: 0.8 },
  divider: { display: "flex", alignItems: "center", gap: 12, margin: "4px 0" },
  dividerText: { fontSize: 11, opacity: 0.35, whiteSpace: "nowrap", color: "#f0ede8" },
  configHint: { fontSize: 11, opacity: 0.4, color: "#f0ede8", lineHeight: 1.6 },
  code: {
    background: "rgba(255,255,255,.08)", padding: "2px 6px",
    borderRadius: 4, fontSize: 10, color: "#1db954",
  },
  btnPrimary: {
    background: "linear-gradient(135deg, #1db954, #1ed760)",
    border: "none", borderRadius: 12,
    padding: "14px 28px", color: "#000",
    fontFamily: "'DM Mono', monospace",
    fontSize: 13, fontWeight: 500,
    cursor: "pointer", width: "100%",
  },
  btnSpotify: {
    background: "#1db954", border: "none", borderRadius: 12,
    padding: "14px 28px", color: "#fff",
    fontFamily: "'DM Mono', monospace",
    fontSize: 14, fontWeight: 500,
    cursor: "pointer", width: "100%",
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  btnSecondary: {
    background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)",
    borderRadius: 12, padding: "12px 20px",
    color: "#f0ede8", fontFamily: "'DM Mono', monospace",
    fontSize: 13, cursor: "pointer",
  },
  // MODAL
  modalOverlay: {
    position: "fixed", inset: 0,
    background: "rgba(0,0,0,.7)", backdropFilter: "blur(8px)",
    zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center",
  },
  modal: {
    background: "#13131a", border: "1px solid rgba(255,255,255,.1)",
    borderRadius: 20, padding: "32px",
    maxWidth: 420, width: "90%",
    fontFamily: "'DM Mono', monospace", color: "#f0ede8",
  },
  modalTitle: {
    fontFamily: "'Fraunces', serif", fontSize: 20,
    marginBottom: 20,
  },
};
