import { useState, useEffect, useCallback, useRef } from "react";

const SPOTIFY_CLIENT_ID = "80383eb1983d4282b296c26b91b75b6d";
const GROQ_API_KEY = "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";
const GROQ_MODEL = "llama-3.1-8b-instant";
const SPOTIFY_SCOPES = [
  "user-read-currently-playing",
  "user-read-playback-state",
  "user-read-recently-played",
  "user-top-read",
].join(" ");

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

// Clé Last.fm intégrée - identifie SpotiLive comme application
const LASTFM_KEY = localStorage.getItem("spotilive_lastfm_key") || "43a8dd6083e2571bf6e47c5d88a88a7f";
async function lastfmFetch(params) {
  const url = new URL("https://ws.audioscrobbler.com/2.0/");
  Object.entries({ ...params, format: "json" }).forEach(([k, v]) => url.searchParams.set(k, v));
  const res = await fetch(url);
  return res.json();
}

async function wikipediaFetch(query, lang = "fr") {
  // 1. Recherche de la page la plus pertinente
  const searchUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=1&format=json&origin=*`;
  const searchRes = await fetch(searchUrl);
  const searchData = await searchRes.json();
  const pageTitle = searchData?.query?.search?.[0]?.title;
  if (!pageTitle) return null;

  // 2. Récupération de l'extrait de la page
  const pageUrl = `https://${lang}.wikipedia.org/w/api.php?action=query&prop=extracts&exintro=1&explaintext=1&titles=${encodeURIComponent(pageTitle)}&format=json&origin=*`;
  const pageRes = await fetch(pageUrl);
  const pageData = await pageRes.json();
  const pages = pageData?.query?.pages;
  if (!pages) return null;
  const page = Object.values(pages)[0];
  return page?.extract || null;
}

function msToTime(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
function fmtNum(n) {
  if (!n) return "—";
  return Number(n).toLocaleString("fr-BE");
}
function cleanAndTruncate(text, maxChars = 600) {
  if (!text) return "";
  // Supprimer contenu entre parenthèses si trop long, nettoyer espaces
  let t = text.replace(/\n+/g, " ").replace(/\s+/g, " ").trim();
  if (t.length <= maxChars) return t;
  // Couper à la fin d'une phrase avant maxChars
  const cut = t.slice(0, maxChars);
  const lastDot = cut.lastIndexOf(".");
  return lastDot > maxChars * 0.6 ? t.slice(0, lastDot + 1) : cut + "…";
}

export default function SpotiLive() {
  const [lastfmUser, setLastfmUser] = useState(() => localStorage.getItem("spotilive_lastfm_user") || "");
  const [lastfmUserInput, setLastfmUserInput] = useState("");
  const [token, setToken] = useState(null);
  const [showConfig, setShowConfig] = useState(false);

  const [current, setCurrent] = useState(null);
  const [progress, setProgress] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const [trackStats, setTrackStats] = useState(null);
  const [artistStats, setArtistStats] = useState(null);
  const [topTracks, setTopTracks] = useState([]);
  const [topArtists, setTopArtists] = useState([]);
  const [recentTracks, setRecentTracks] = useState([]);
  const [lastfmProfile, setLastfmProfile] = useState(null);

  const [aiContent, setAiContent] = useState(null);
  const [quickInfo, setQuickInfo] = useState({ genre: "—", ambiance: "—", playcount: null });
  const [recommendations, setRecommendations] = useState({ tracks: [], artists: [] });
  const [aiLoading, setAiLoading] = useState(false);

  const [activeTab, setActiveTab] = useState("now");
  const pollRef = useRef(null);
  const lastTrackRef = useRef(null);
  const progressRef = useRef(null);

  const refreshAccessToken = useCallback(async () => {
    const refreshToken = localStorage.getItem("spotify_refresh_token");
    if (!refreshToken) return null;
    try {
      const res = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          client_id: SPOTIFY_CLIENT_ID,
        }),
      });
      const data = await res.json();
      if (data.access_token) {
        setToken(data.access_token);
        sessionStorage.setItem("spotify_token", data.access_token);
        const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
        localStorage.setItem("spotify_expires_at", expiresAt);
        // Spotify peut envoyer un nouveau refresh token
        if (data.refresh_token) {
          localStorage.setItem("spotify_refresh_token", data.refresh_token);
        }
        return data.access_token;
      }
    } catch (e) {
      console.warn("Refresh token failed:", e);
    }
    return null;
  }, []);

  const handleSpotifyLogin = async () => {
    const verifier = generateCodeVerifier();
    const challenge = await generateCodeChallenge(verifier);
    sessionStorage.setItem("pkce_verifier", verifier);
    const redirectUri = window.location.href.split("?")[0].split("#")[0];
    sessionStorage.setItem("pkce_redirect", redirectUri);
    const params = new URLSearchParams({
      client_id: SPOTIFY_CLIENT_ID, response_type: "code", redirect_uri: redirectUri,
      scope: SPOTIFY_SCOPES, code_challenge_method: "S256", code_challenge: challenge,
    });
    window.location.href = "https://accounts.spotify.com/authorize?" + params;
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("code");
    const verifier = sessionStorage.getItem("pkce_verifier");
    const redirectUri = sessionStorage.getItem("pkce_redirect");
    if (code && verifier) {
      window.history.replaceState({}, "", window.location.pathname);
      fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "authorization_code", code,
          redirect_uri: redirectUri, client_id: SPOTIFY_CLIENT_ID, code_verifier: verifier,
        }),
      }).then(r => r.json()).then(data => {
        if (data.access_token) {
          setToken(data.access_token);
          sessionStorage.setItem("spotify_token", data.access_token);
          // Stocker le refresh token en localStorage pour persister entre sessions
          if (data.refresh_token) {
            localStorage.setItem("spotify_refresh_token", data.refresh_token);
          }
          // Stocker l'expiration (expires_in est en secondes, généralement 3600)
          const expiresAt = Date.now() + (data.expires_in || 3600) * 1000;
          localStorage.setItem("spotify_expires_at", expiresAt);
          sessionStorage.removeItem("pkce_verifier");
        }
      });
    } else {
      // Vérifier si on a un token en session encore valide
      const saved = sessionStorage.getItem("spotify_token");
      const expiresAt = localStorage.getItem("spotify_expires_at");
      const refreshToken = localStorage.getItem("spotify_refresh_token");

      if (saved && expiresAt && Date.now() < Number(expiresAt) - 60000) {
        // Token encore valide (avec 1 min de marge)
        setToken(saved);
      } else if (refreshToken) {
        // Token expiré mais on a un refresh token → renouveler silencieusement
        refreshAccessToken();
      }
    }
  }, []);

  const spotifyFetch = useCallback(async (path) => {
    if (!token) return null;
    const res = await fetch(`https://api.spotify.com/v1/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status === 401) {
      // Token expiré → tenter un refresh automatique
      const newToken = await refreshAccessToken();
      if (newToken) {
        // Réessayer la requête avec le nouveau token
        const retry = await fetch(`https://api.spotify.com/v1/${path}`, {
          headers: { Authorization: `Bearer ${newToken}` },
        });
        if (retry.status === 204 || retry.status === 202) return null;
        if (retry.ok) return retry.json();
      }
      // Refresh échoué → déconnecter
      setToken(null);
      sessionStorage.removeItem("spotify_token");
      localStorage.removeItem("spotify_refresh_token");
      localStorage.removeItem("spotify_expires_at");
      return null;
    }
    if (res.status === 204 || res.status === 202) return null;
    return res.json();
  }, [token, refreshAccessToken]);





  const fetchLastfmStats = useCallback(async () => {
    if (!lastfmUser) return;
    const key = LASTFM_KEY;
    try {
      const [profile, recent] = await Promise.all([
        lastfmFetch({ method: "user.getInfo", api_key: key, user: lastfmUser }),
        lastfmFetch({ method: "user.getRecentTracks", api_key: key, user: lastfmUser, limit: 10 }),
      ]);
      setLastfmProfile(profile?.user);
      const tracks = recent?.recenttracks?.track || [];
      setRecentTracks(Array.isArray(tracks) ? tracks.slice(0, 10) : [tracks]);
    } catch {}
  }, [lastfmUser]);

  const fetchSpotifyStats = useCallback(async () => {
    const [top4w, topArt] = await Promise.all([
      spotifyFetch("me/top/tracks?time_range=short_term&limit=10"),
      spotifyFetch("me/top/artists?time_range=short_term&limit=8"),
    ]);
    if (top4w?.items) setTopTracks(top4w.items);
    if (topArt?.items) setTopArtists(topArt.items);
  }, [spotifyFetch]);

  const fetchRecommendations = async (track) => {
    const currentToken = sessionStorage.getItem("spotify_token");
    if (!currentToken) return;
    try {
      const artistId = track.artists[0].id;
      const trackId = track.id;
      // Spotify recommendations endpoint
      const res = await fetch(
        `https://api.spotify.com/v1/recommendations?seed_artists=${artistId}&seed_tracks=${trackId}&limit=10`,
        { headers: { Authorization: `Bearer ${currentToken}` } }
      );
      if (!res.ok) return;
      const data = await res.json();
      const recTracks = data.tracks || [];
      // Extract unique artists from recommended tracks
      const artistMap = new Map();
      recTracks.forEach(t => {
        t.artists.forEach(a => {
          if (a.id !== artistId && !artistMap.has(a.id)) {
            artistMap.set(a.id, { id: a.id, name: a.name, uri: a.uri });
          }
        });
      });
      setRecommendations({
        tracks: recTracks.slice(0, 6),
        artists: Array.from(artistMap.values()).slice(0, 6),
      });
    } catch (e) {
      console.warn("Recommendations error:", e);
    }
  };

  const generateAiContent = async (track) => {
    setAiContent(null);
    setAiLoading(true);
    setQuickInfo({ genre: "—", ambiance: "—", playcount: null });
    setRecommendations({ tracks: [], artists: [] });
    try {
      const artistName = track.artists[0].name;
      const trackName = track.name;
      const albumName = track.album.name;
      const yr = track.album.release_date?.slice(0, 4) || "";
      const key = LASTFM_KEY;

      // Toutes les sources en parallèle (y compris genres Spotify)
      const currentToken = sessionStorage.getItem("spotify_token");
      const [spotifyArtistRes, lfmArtistRes, lfmTrackRes, mbRes, wikiArtistRaw, wikiTrackRaw] = await Promise.all([
        currentToken
          ? fetch(`https://api.spotify.com/v1/artists/${track.artists[0].id}`, {
              headers: { Authorization: `Bearer ${currentToken}` }
            }).then(r => r.ok ? r.json() : null).catch(() => null)
          : Promise.resolve(null),
        lastfmFetch({ method: "artist.getInfo", api_key: key, artist: artistName, lang: "fr" }).catch(() => ({})),
        lastfmFetch({ method: "track.getInfo", api_key: key, artist: artistName, track: trackName }).catch(() => ({})),
        fetch(
          `https://musicbrainz.org/ws/2/recording/?query=recording:"${encodeURIComponent(trackName)}" AND artist:"${encodeURIComponent(artistName)}"&limit=1&fmt=json`,
          { headers: { "User-Agent": "SpotiLive/1.0 (https://spotilive.netlify.app)" } }
        ).then(r => r.json()).catch(() => ({})),
        wikipediaFetch(artistName, "fr").catch(() => null),
        wikipediaFetch(`${trackName} ${artistName}`, "fr").catch(() => null),
      ]);
      const spotifyGenres = spotifyArtistRes?.genres || [];

      const lfmArtist = lfmArtistRes?.artist;
      const lfmTrack = lfmTrackRes?.track;
      const mbRecording = mbRes?.recordings?.[0];

      // 3. Genre & Ambiance : Spotify en priorité, puis Last.fm
      const lfmTags = lfmArtist?.tags?.tag?.map(t => t.name) || lfmTrack?.toptags?.tag?.map(t => t.name) || [];
      const allGenres = [...spotifyGenres, ...lfmTags];
      const genre = allGenres[0] || "—";
      const ambiance = allGenres.slice(1, 3).join(", ") || "—";

      // Afficher immédiatement les stats rapides AVANT Groq
      setTrackStats({ lastfm: lfmTrack });
      setArtistStats({ lastfm: lfmArtist });
      setQuickInfo({
        genre: genre,
        ambiance: ambiance,
        playcount: lfmTrack?.playcount || null,
      });

      // 4. Sources brutes pour Groq
      const wikiArtistClean = wikiArtistRaw ? cleanAndTruncate(wikiArtistRaw, 800) : "";
      const wikiTrackClean = wikiTrackRaw ? cleanAndTruncate(wikiTrackRaw, 500) : "";
      const lfmBioClean = cleanAndTruncate(
        (lfmArtist?.bio?.content || lfmArtist?.bio?.summary || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(), 400
      );
      const lfmWikiClean = cleanAndTruncate(
        (lfmTrack?.wiki?.content || lfmTrack?.wiki?.summary || "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(), 300
      );
      const mbDate = mbRecording?.releases?.[0]?.date || "";
      const mbCountry = mbRecording?.releases?.[0]?.country || "";
      const mbDur = mbRecording?.length
        ? `${Math.floor(mbRecording.length/60000)}m${String(Math.floor((mbRecording.length%60000)/1000)).padStart(2,"0")}s`
        : "";
      const mbReleases = mbRecording?.releases?.length || 0;
      const lfmPlays = lfmTrack?.playcount ? Number(lfmTrack.playcount).toLocaleString("fr-BE") : "";
      const lfmListeners = lfmArtist?.stats?.listeners ? Number(lfmArtist.stats.listeners).toLocaleString("fr-BE") : "";

      // 5. Groq en priorité absolue
      const prompt = `Tu es un expert musical passionné. Réponds UNIQUEMENT en français, avec des phrases riches et complètes. Ne commence jamais une section par "Je ne sais pas" ou "Peu d'informations" : utilise toujours ce que tu connais de l'artiste et du genre musical pour enrichir ta réponse.

Informations disponibles :
- Artiste : ${artistName}
- Chanson : "${trackName}"
- Album : ${albumName} (${yr})
- Genres Spotify : ${spotifyGenres.join(", ") || "non disponibles"}
- Tags Last.fm : ${lfmTags.join(", ") || "non disponibles"}
- Wikipedia artiste : ${wikiArtistClean || "non disponible"}
- Wikipedia chanson : ${wikiTrackClean || "non disponible"}
- Bio Last.fm : ${lfmBioClean || "non disponible"}
- Info chanson Last.fm : ${lfmWikiClean || "non disponible"}
- MusicBrainz : durée ${mbDur || "?"}, sortie ${mbDate || "?"}, pays ${mbCountry || "?"}
- Écoutes Last.fm : ${lfmPlays || "non disponible"}
- Auditeurs Last.fm : ${lfmListeners || "non disponible"}

Écris exactement 3 sections séparées par la ligne ---

BIO
Biographie complète et passionnante de ${artistName} en 5-6 phrases. Inclure : origines, style musical, influences, carrière, albums importants, anecdotes marquantes. Utilise Wikipedia et Last.fm. Développe généreusement même si les sources sont limitées.

---

CHANSON
Histoire et contexte de "${trackName}" en 4-5 phrases. Contexte de création, thèmes abordés, ambiance sonore, réception, place dans la discographie. Développe à partir du style de l'artiste et de l'époque si peu d'infos spécifiques.

---

ANECDOTES
3 anecdotes fascinantes sur l'artiste ou la chanson, une par ligne, commençant par un tiret. Mélange faits factuels (dates, chiffres MusicBrainz/Last.fm) et contexte culturel pertinent.`;

      let bio = "";
      let explication = "";
      let anecdotes = [];

      const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${GROQ_API_KEY}`,
        },
        body: JSON.stringify({
          model: GROQ_MODEL,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.6,
          max_tokens: 1400,
        }),
      });
      const groqData = await groqRes.json();
      const raw = groqData.choices?.[0]?.message?.content || "";

      if (raw) {
        // Parsing robuste : Groq peut varier les séparateurs et la casse
        // On split sur toute variante de --- (avec ou sans espaces, newlines)
        const parts = raw.split(/\n\s*---+\s*\n/);

        const extract = (label) => {
          // Cherche la section par son label en début de bloc (insensible casse)
          const idx = parts.findIndex(p => p.trim().toUpperCase().startsWith(label.toUpperCase()));
          if (idx === -1) {
            // Fallback : cherche le label n'importe où dans le bloc
            const idx2 = parts.findIndex(p => p.toUpperCase().includes("\n" + label.toUpperCase()));
            if (idx2 === -1) return "";
            const sec2 = parts[idx2];
            const labelPos = sec2.toUpperCase().indexOf(label.toUpperCase());
            const afterLabel = sec2.slice(labelPos + label.length).trim();
            return afterLabel.startsWith("\n") ? afterLabel.slice(1).trim() : afterLabel;
          }
          const sec = parts[idx].trim();
          // Supprimer la première ligne (le label lui-même)
          const nl = sec.indexOf("\n");
          return nl === -1 ? sec : sec.slice(nl).trim();
        };

        bio = extract("BIO");
        explication = extract("CHANSON");
        const anecdotesRaw = extract("ANECDOTES");

        // Parser les anecdotes : lignes commençant par -, *, •, chiffre, ou lettre
        anecdotes = anecdotesRaw
          .split("\n")
          .map(l => l.trim())
          .filter(l => l.length > 10)
          .map(l => { const t = l.trim(); return t.replace(/^[-*\u2022\u00b7\d.]+\s*/, "").trim() || t; })
          .filter(Boolean)
          .slice(0, 4);
      }

      // 6. Fallbacks uniquement si Groq échoue complètement
      if (!bio) {
        bio = wikiArtistClean || lfmBioClean || `${artistName} est un artiste musical dont les informations biographiques n'ont pas pu être récupérées.`;
      }
      if (!explication) {
        const dur = track.duration_ms
          ? `${Math.floor(track.duration_ms/60000)}m${String(Math.floor((track.duration_ms%60000)/1000)).padStart(2,"0")}s`
          : null;
        explication = `"${trackName}" est un titre de ${artistName}, extrait de l'album "${albumName}"${yr ? ` (${yr})` : ""}${dur ? `. Durée : ${dur}` : ""}.`;
      }
      if (anecdotes.length === 0) {
        if (mbDur) anecdotes.push(`Durée officielle selon MusicBrainz : ${mbDur}.`);
        if (mbDate) anecdotes.push(`Date de sortie officielle : ${mbDate}.`);
        if (mbCountry) anecdotes.push(`Pays de sortie : ${mbCountry}.`);
        if (lfmPlays) anecdotes.push(`Ce titre totalise ${lfmPlays} écoutes sur Last.fm.`);
        if (lfmListeners) anecdotes.push(`${lfmListeners} auditeurs uniques sur Last.fm.`);
        if (mbReleases > 1) anecdotes.push(`Ce titre est apparu sur ${mbReleases} sorties selon MusicBrainz.`);
      }

      setAiContent({ bio, explication, anecdotes, genre, ambiance });
    } catch (e) {
      console.error("generateAiContent error:", e);
      setAiContent({ bio: "Données indisponibles.", explication: "", anecdotes: [], genre: "—", ambiance: "—" });
    }
    setAiLoading(false);
  };


  const fetchCurrent = useCallback(async () => {
    const data = await spotifyFetch("me/player/currently-playing");
    if (!data || !data.item) { setCurrent(null); setIsPlaying(false); return; }
    setIsPlaying(data.is_playing);
    setProgress(data.progress_ms || 0);
    const track = data.item;
    setCurrent(track);
    if (track.id !== lastTrackRef.current) {
      lastTrackRef.current = track.id;
      generateAiContent(track);
      fetchRecommendations(track);
    }
  }, [spotifyFetch]);

  useEffect(() => {
    if (!token) return;
    fetchCurrent();
    fetchSpotifyStats();
    fetchLastfmStats();
    pollRef.current = setInterval(() => { fetchCurrent(); fetchLastfmStats(); }, 15000);
    return () => clearInterval(pollRef.current);
  }, [token, fetchCurrent, fetchSpotifyStats, fetchLastfmStats]);

  useEffect(() => {
    if (!isPlaying || !current) return;
    progressRef.current = setInterval(() => {
      setProgress(p => Math.min(p + 1000, current.duration_ms));
    }, 1000);
    return () => clearInterval(progressRef.current);
  }, [isPlaying, current]);

  const saveConfig = () => {
    const newUser = lastfmUserInput.trim() || lastfmUser;
    if (newUser) {
      localStorage.setItem("spotilive_lastfm_user", newUser);
      setLastfmUser(newUser);
    }
    setLastfmUserInput("");
    setShowConfig(false);
  };

  const logout = () => {
    setToken(null);
    sessionStorage.removeItem("spotify_token");
    localStorage.removeItem("spotify_refresh_token");
    localStorage.removeItem("spotify_expires_at");
    setCurrent(null); setAiContent(null); setTrackStats(null); setRecommendations({ tracks: [], artists: [] });
    setQuickInfo({ genre: "—", ambiance: "—", playcount: null });
  };

  const pct = current ? (progress / current.duration_ms) * 100 : 0;

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
              placeholder="Votre username Last.fm"
              value={lastfmUserInput}
              onChange={e => setLastfmUserInput(e.target.value)}
            />
            {lastfmUserInput && (
              <button style={{ ...styles.btnPrimary, marginTop: 8 }} onClick={() => {
                localStorage.setItem("spotilive_lastfm_user", lastfmUserInput.trim());
                setLastfmUser(lastfmUserInput.trim());
              }}>Sauvegarder</button>
            )}
            <p style={{ fontSize: 11, opacity: 0.4, color: "#f0ede8", lineHeight: 1.6 }}>
              Entrez votre pseudo Last.fm pour voir vos statistiques d'écoute personnelles.
            </p>
          </div>
        </div>
        <style>{`@import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,600&family=DM+Mono:wght@300;400&display=swap'); *{box-sizing:border-box;margin:0;padding:0}`}</style>
      </div>
    );
  }

  return (
    <div style={styles.app}>
      {current?.album?.images?.[0]?.url && (
        <div style={{ ...styles.ambientBg, backgroundImage: `url(${current.album.images[0].url})` }} />
      )}
      <div style={styles.overlay} />

      <header style={styles.header}>
        <div style={styles.headerLogo}>SpotiLive</div>
        <div style={styles.headerRight}>
          {lastfmProfile && <span style={styles.lfmBadge}>📻 {lastfmProfile.name} · {fmtNum(lastfmProfile.playcount)} écoutes</span>}
          <button style={styles.btnIcon} onClick={() => { setLastfmUserInput(lastfmUser); setShowConfig(true); }}>⚙</button>
          <button style={styles.btnIcon} onClick={logout}>✕</button>
        </div>
      </header>

      <nav style={styles.tabs}>
        {["now", "stats", "history"].map(tab => (
          <button key={tab} style={{ ...styles.tab, ...(activeTab === tab ? styles.tabActive : {}) }} onClick={() => setActiveTab(tab)}>
            {{ now: "En cours", stats: "Statistiques", history: "Historique" }[tab]}
          </button>
        ))}
      </nav>

      <main style={styles.main}>
        {activeTab === "now" && (
          <div style={styles.nowGrid}>
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
                  <div style={styles.progressWrap}>
                    <span style={styles.timeLabel}>{msToTime(progress)}</span>
                    <div style={styles.progressBar}><div style={{ ...styles.progressFill, width: `${pct}%` }} /></div>
                    <span style={styles.timeLabel}>{msToTime(current.duration_ms)}</span>
                  </div>
                  <div style={styles.quickStats}>
                    {[
                      ["Écoutes", quickInfo.playcount ? fmtNum(quickInfo.playcount) : (trackStats?.lastfm?.playcount ? fmtNum(trackStats.lastfm.playcount) : "—")],
                      ["Genre", quickInfo.genre || "—"],
                      ["Ambiance", quickInfo.ambiance || "—"],
                    ].map(([k, v]) => (
                      <div key={k} style={styles.quickStat}>
                        <span style={styles.qsLabel}>{k}</span>
                        <span style={styles.qsValue}>{v}</span>
                      </div>
                    ))}
                  </div>

                  <div style={{ background: "rgba(255,80,80,.12)", border: "1px solid rgba(255,80,80,.3)", borderRadius: 8, padding: "8px 12px", fontSize: 11, lineHeight: 1.8, color: "#f0ede8" }}>
                    <div>Genre: <b>{quickInfo.genre}</b> | Ambiance: <b>{quickInfo.ambiance}</b></div>
                    <div>Écoutes: <b>{quickInfo.playcount || "null"}</b></div>
                    <div>Recs: <b>{recommendations.tracks.length}</b> titres, <b>{recommendations.artists.length}</b> artistes</div>
                  </div>
                </>
              ) : (
                <div style={styles.nothing}>
                  <div style={styles.nothingIcon}>♪</div>
                  <p>Aucune lecture en cours</p>
                  <p style={{ opacity: 0.5, fontSize: 13 }}>Lancez Spotify pour voir apparaître votre musique ici</p>
                </div>
              )}
            </div>

            <div style={styles.aiCol}>
              {aiLoading ? (
                <div style={styles.aiLoading}>
                  <div style={styles.aiSpinner} />
                  <p>Chargement…</p>
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
                          <li key={i} style={styles.anecdoteItem}><span style={styles.anecdoteDot}>✦</span>{a}</li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {trackStats?.lastfm && (
                    <div style={styles.aiBlock}>
                      <h3 style={styles.aiTitle}>Données Last.fm</h3>
                      <div style={styles.lfmGrid}>
                        <div style={styles.lfmStat}><span style={styles.lfmVal}>{fmtNum(trackStats.lastfm.playcount)}</span><span style={styles.lfmLbl}>écoutes globales</span></div>
                        <div style={styles.lfmStat}><span style={styles.lfmVal}>{fmtNum(trackStats.lastfm.listeners)}</span><span style={styles.lfmLbl}>auditeurs</span></div>
                        {trackStats.lastfm.userplaycount > 0 && <div style={styles.lfmStat}><span style={styles.lfmVal}>{fmtNum(trackStats.lastfm.userplaycount)}</span><span style={styles.lfmLbl}>vos écoutes</span></div>}
                      </div>
                      {trackStats.lastfm.toptags?.tag?.length > 0 && (
                        <div style={styles.tagsRow}>
                          {trackStats.lastfm.toptags.tag.slice(0, 5).map(t => <span key={t.name} style={styles.tag}>{t.name}</span>)}
                        </div>
                      )}
                    </div>
                  )}
                  {artistStats?.lastfm && (
                    <div style={styles.aiBlock}>
                      <h3 style={styles.aiTitle}>Artiste · Last.fm</h3>
                      <div style={styles.lfmGrid}>
                        <div style={styles.lfmStat}><span style={styles.lfmVal}>{fmtNum(artistStats.lastfm.stats?.playcount)}</span><span style={styles.lfmLbl}>écoutes</span></div>
                        <div style={styles.lfmStat}><span style={styles.lfmVal}>{fmtNum(artistStats.lastfm.stats?.listeners)}</span><span style={styles.lfmLbl}>auditeurs</span></div>
                      </div>
                    </div>
                  )}

                  {recommendations.tracks.length > 0 && (
                    <div style={styles.aiBlock}>
                      <h3 style={styles.aiTitle}>Titres similaires</h3>
                      <div style={styles.recList}>
                        {recommendations.tracks.map(t => (
                          <a
                            key={t.id}
                            href={t.uri}
                            style={styles.recItem}
                            onClick={e => { e.preventDefault(); window.location.href = t.uri; }}
                          >
                            {t.album?.images?.[2]?.url && (
                              <img src={t.album.images[2].url} alt="" style={styles.recThumb} />
                            )}
                            <div style={styles.recInfo}>
                              <span style={styles.recTitle}>{t.name}</span>
                              <span style={styles.recSub}>{t.artists.map(a => a.name).join(", ")}</span>
                            </div>
                            <span style={styles.recArrow}>▶</span>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}

                  {recommendations.artists.length > 0 && (
                    <div style={styles.aiBlock}>
                      <h3 style={styles.aiTitle}>Artistes similaires</h3>
                      <div style={styles.recList}>
                        {recommendations.artists.map(a => (
                          <a
                            key={a.id}
                            href={a.uri}
                            style={styles.recItem}
                            onClick={e => { e.preventDefault(); window.location.href = a.uri; }}
                          >
                            <div style={{ ...styles.recThumb, background: "rgba(29,185,84,.15)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18 }}>🎤</div>
                            <div style={styles.recInfo}>
                              <span style={styles.recTitle}>{a.name}</span>
                            </div>
                            <span style={styles.recArrow}>▶</span>
                          </a>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              ) : current ? null : (
                <div style={styles.aiPlaceholder}><p>Les informations apparaîtront ici</p></div>
              )}
            </div>
          </div>
        )}

        {activeTab === "stats" && (
          <div style={styles.statsGrid}>
            {lastfmProfile && (
              <div style={styles.statCard}>
                <h3 style={styles.cardTitle}>📻 Profil Last.fm</h3>
                <div style={styles.profileRow}>
                  {lastfmProfile.image?.[2]?.["#text"] && <img src={lastfmProfile.image[2]["#text"]} alt="Avatar" style={styles.avatar} />}
                  <div>
                    <p style={styles.profileName}>{lastfmProfile.name}</p>
                    <p style={styles.profileSub}>{fmtNum(lastfmProfile.playcount)} écoutes au total</p>
                    <p style={styles.profileSub}>Membre depuis {new Date(lastfmProfile.registered?.unixtime * 1000).getFullYear()}</p>
                    {lastfmProfile.country && <p style={styles.profileSub}>📍 {lastfmProfile.country}</p>}
                  </div>
                </div>
              </div>
            )}
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

        {activeTab === "history" && (
          <div style={styles.historyWrap}>
            <h3 style={styles.cardTitle}>🕐 Dernières écoutes · Last.fm</h3>
            {recentTracks.length === 0 ? (
              <p style={{ opacity: 0.5, marginTop: 12 }}>Configurez votre username Last.fm via ⚙</p>
            ) : (
              <div style={styles.historyList}>
                {recentTracks.map((t, i) => (
                  <div key={i} style={styles.historyItem}>
                    {t.image?.[1]?.["#text"] && <img src={t.image[1]["#text"]} alt="" style={styles.historyThumb} />}
                    <div style={styles.historyInfo}>
                      <span style={styles.historyTitle}>{t.name}</span>
                      <span style={styles.historySub}>{t.artist?.["#text"] || t.artist?.name} · {t.album?.["#text"]}</span>
                    </div>
                    <span style={styles.historyTime}>{t["@attr"]?.nowplaying ? "▶" : t.date?.["#text"]?.slice(0, -6) || ""}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>

      {showConfig && (
        <div style={styles.modalOverlay} onClick={() => setShowConfig(false)}>
          <div style={styles.modal} onClick={e => e.stopPropagation()}>
            <h2 style={styles.modalTitle}>Configuration</h2>
            <div style={styles.configSection}>
              <label style={styles.configLabel}>Username Last.fm</label>
              <input style={styles.configInput} placeholder="Votre pseudo Last.fm" value={lastfmUserInput} onChange={e => setLastfmUserInput(e.target.value)} />
              <p style={{ fontSize: 11, opacity: 0.4, color: "#f0ede8", marginTop: 6, lineHeight: 1.6 }}>
                Entrez votre pseudo Last.fm pour voir vos stats d'écoute.
              </p>
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
              <button style={styles.btnPrimary} onClick={saveConfig}>Sauvegarder</button>
              <button style={styles.btnSecondary} onClick={() => setShowConfig(false)}>Annuler</button>
            </div>
          </div>
        </div>
      )}

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,300;0,9..144,600&family=DM+Mono:wght@300;400&display=swap');
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes ring { 0%{transform:scale(1);opacity:.8} 100%{transform:scale(1.15);opacity:0} }
        html, body, #root { width: 100%; height: 100%; min-height: 100vh; min-height: 100dvh; }
        ::-webkit-scrollbar { width: 4px; } ::-webkit-scrollbar-thumb { background: rgba(255,255,255,.2); border-radius: 2px; }
      `}</style>
    </div>
  );
}

const styles = {
  app: { display: "flex", flexDirection: "column", minHeight: "100vh", minHeight: "100dvh", width: "100%", background: "#0a0a0f", color: "#f0ede8", fontFamily: "'DM Mono', monospace", position: "relative", overflowX: "hidden" },
  ambientBg: { position: "fixed", inset: 0, width: "100%", height: "100%", backgroundSize: "cover", backgroundPosition: "center", filter: "blur(80px) saturate(1.8)", opacity: 0.12, transform: "scale(1.1)", transition: "background-image 2s ease", zIndex: 0 },
  overlay: { position: "fixed", inset: 0, background: "linear-gradient(180deg, rgba(10,10,15,.95) 0%, rgba(10,10,15,.85) 100%)", zIndex: 1 },
  header: { position: "relative", zIndex: 10, display: "flex", alignItems: "center", justifyContent: "space-between", padding: "14px 16px", borderBottom: "1px solid rgba(255,255,255,.06)", backdropFilter: "blur(20px)", width: "100%" },
  headerLogo: { fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 600, background: "linear-gradient(135deg, #1db954, #1ed760)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent" },
  headerRight: { display: "flex", alignItems: "center", gap: 12 },
  lfmBadge: { fontSize: 11, opacity: 0.6, background: "rgba(255,255,255,.06)", padding: "5px 10px", borderRadius: 20 },
  btnIcon: { background: "rgba(255,255,255,.08)", border: "none", color: "#f0ede8", cursor: "pointer", width: 32, height: 32, borderRadius: "50%", fontSize: 14 },
  tabs: { position: "relative", zIndex: 10, display: "flex", gap: 4, padding: "12px 16px 0" },
  tab: { background: "none", border: "none", color: "rgba(240,237,232,.4)", cursor: "pointer", fontSize: 13, padding: "8px 16px", borderRadius: "8px 8px 0 0", fontFamily: "'DM Mono', monospace", transition: "all .2s" },
  tabActive: { background: "rgba(255,255,255,.06)", color: "#f0ede8", borderBottom: "2px solid #1db954" },
  main: { flex: 1, position: "relative", zIndex: 10, padding: "16px", maxWidth: 1200, margin: "0 auto", width: "100%", overflowY: "auto" },
  nowGrid: { display: "flex", flexDirection: "column", gap: 20, maxWidth: "min(600px, 100%)", margin: "0 auto", width: "100%" },
  playerCol: { display: "flex", flexDirection: "column", gap: 16, alignItems: "center" },
  albumWrap: { position: "relative", alignSelf: "center", width: 220, height: 220 },
  albumArt: { width: "100%", height: "100%", borderRadius: 16, boxShadow: "0 20px 60px rgba(0,0,0,.6)", position: "relative", zIndex: 2 },
  playingRing: { position: "absolute", inset: -8, border: "2px solid #1db954", borderRadius: 24, animation: "ring 2s ease-out infinite", zIndex: 1 },
  trackInfo: { textAlign: "center", width: "100%" },
  trackName: { fontFamily: "'Fraunces', serif", fontSize: 22, fontWeight: 600, lineHeight: 1.2, marginBottom: 6 },
  artistName: { fontSize: 15, opacity: 0.8, marginBottom: 4 },
  albumName: { fontSize: 12, opacity: 0.45 },
  progressWrap: { display: "flex", alignItems: "center", gap: 8, width: "100%" },
  progressBar: { flex: 1, height: 3, background: "rgba(255,255,255,.12)", borderRadius: 2, overflow: "hidden" },
  progressFill: { height: "100%", background: "linear-gradient(90deg, #1db954, #1ed760)", borderRadius: 2, transition: "width 1s linear" },
  timeLabel: { fontSize: 11, opacity: 0.45, fontVariantNumeric: "tabular-nums" },
  quickStats: { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, width: "100%" },
  quickStat: { background: "rgba(255,255,255,.04)", borderRadius: 10, padding: "10px 14px", display: "flex", flexDirection: "column", gap: 3 },
  qsLabel: { fontSize: 10, opacity: 0.4, textTransform: "uppercase", letterSpacing: 1 },
  qsValue: { fontSize: 14, fontWeight: 500 },
  popWrap: { display: "flex", flexDirection: "column", gap: 6, width: "100%" },
  popLabel: { fontSize: 10, opacity: 0.4, textTransform: "uppercase", letterSpacing: 1 },
  popBar: { height: 4, background: "rgba(255,255,255,.08)", borderRadius: 2, overflow: "hidden" },
  popFill: { height: "100%", background: "linear-gradient(90deg, #1db954, #1ed760)", borderRadius: 2 },
  nothing: { textAlign: "center", opacity: 0.4, padding: "60px 20px", display: "flex", flexDirection: "column", gap: 12, alignItems: "center" },
  nothingIcon: { fontSize: 48 },
  aiCol: { display: "flex", flexDirection: "column", gap: 14, width: "100%" },
  aiLoading: { display: "flex", flexDirection: "column", alignItems: "center", gap: 16, padding: 60, opacity: 0.5 },
  aiSpinner: { width: 28, height: 28, border: "2px solid rgba(255,255,255,.2)", borderTopColor: "#1db954", borderRadius: "50%", animation: "spin 1s linear infinite" },
  aiBlock: { background: "rgba(255,255,255,.04)", borderRadius: 14, padding: "18px 20px", border: "1px solid rgba(255,255,255,.06)" },
  aiTitle: { fontSize: 10, fontWeight: 400, textTransform: "uppercase", letterSpacing: 2, opacity: 0.4, marginBottom: 10, color: "#1db954" },
  aiText: { fontSize: 14, lineHeight: 1.8, opacity: 0.85 },
  anecdoteList: { listStyle: "none", display: "flex", flexDirection: "column", gap: 10 },
  anecdoteItem: { display: "flex", gap: 10, fontSize: 13, lineHeight: 1.6, opacity: 0.8 },
  anecdoteDot: { color: "#1db954", flexShrink: 0, marginTop: 2 },
  lfmGrid: { display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 10 },
  lfmStat: { display: "flex", flexDirection: "column", gap: 2 },
  lfmVal: { fontSize: 18, fontFamily: "'Fraunces', serif", fontWeight: 600 },
  lfmLbl: { fontSize: 10, opacity: 0.4 },
  tagsRow: { display: "flex", flexWrap: "wrap", gap: 6 },
  tag: { fontSize: 11, padding: "3px 8px", background: "rgba(29,185,84,.12)", color: "#1db954", borderRadius: 20 },
  aiPlaceholder: { padding: 40, textAlign: "center", opacity: 0.3, fontSize: 13 },
  recList: { display: "flex", flexDirection: "column", gap: 2 },
  recItem: { display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: "1px solid rgba(255,255,255,.04)", textDecoration: "none", color: "#f0ede8", cursor: "pointer" },
  recThumb: { width: 38, height: 38, borderRadius: 6, flexShrink: 0, objectFit: "cover" },
  recInfo: { flex: 1, minWidth: 0 },
  recTitle: { display: "block", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  recSub: { display: "block", fontSize: 11, opacity: 0.45, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  recArrow: { fontSize: 10, opacity: 0.3, flexShrink: 0, color: "#1db954" },
  statsGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(300px, 1fr))", gap: 20 },
  statCard: { background: "rgba(255,255,255,.04)", borderRadius: 16, padding: "20px", border: "1px solid rgba(255,255,255,.06)" },
  cardTitle: { fontSize: 13, fontWeight: 400, marginBottom: 16, opacity: 0.7, fontFamily: "'Fraunces', serif" },
  profileRow: { display: "flex", gap: 14, alignItems: "center" },
  avatar: { width: 52, height: 52, borderRadius: "50%" },
  profileName: { fontSize: 16, fontWeight: 600, marginBottom: 4 },
  profileSub: { fontSize: 12, opacity: 0.5, lineHeight: 1.8 },
  rankList: { listStyle: "none", display: "flex", flexDirection: "column", gap: 8 },
  rankItem: { display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,.04)" },
  rankNum: { fontSize: 11, opacity: 0.3, width: 18, textAlign: "right" },
  rankThumb: { width: 36, height: 36, borderRadius: 6 },
  rankInfo: { flex: 1, minWidth: 0 },
  rankTitle: { display: "block", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  rankSub: { display: "block", fontSize: 11, opacity: 0.4 },
  rankPop: { fontSize: 11, opacity: 0.35 },
  artistsGrid: { display: "flex", flexDirection: "column", gap: 8 },
  artistChip: { display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: "1px solid rgba(255,255,255,.04)" },
  artistThumb: { width: 38, height: 38, borderRadius: "50%" },
  artistChipName: { fontSize: 13 },
  artistChipSub: { fontSize: 11, opacity: 0.4 },
  rankNumSm: { fontSize: 11, opacity: 0.25, marginLeft: "auto" },
  historyWrap: { background: "rgba(255,255,255,.04)", borderRadius: 16, padding: "20px", border: "1px solid rgba(255,255,255,.06)" },
  historyList: { display: "flex", flexDirection: "column", gap: 2, marginTop: 12 },
  historyItem: { display: "flex", alignItems: "center", gap: 12, padding: "10px 0", borderBottom: "1px solid rgba(255,255,255,.04)" },
  historyThumb: { width: 40, height: 40, borderRadius: 6, flexShrink: 0 },
  historyInfo: { flex: 1, minWidth: 0 },
  historyTitle: { display: "block", fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  historySub: { display: "block", fontSize: 11, opacity: 0.4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  historyTime: { fontSize: 11, opacity: 0.35, flexShrink: 0 },
  configScreen: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "100vh", minHeight: "100dvh", width: "100%", background: "#0a0a0f", fontFamily: "'DM Mono', monospace", padding: "16px" },
  configCard: { background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.08)", borderRadius: 20, padding: "clamp(24px, 5vw, 40px)", maxWidth: 480, width: "100%", display: "flex", flexDirection: "column", gap: 20 },
  logo: { fontFamily: "'Fraunces', serif", fontSize: 32, fontWeight: 600, background: "linear-gradient(135deg, #1db954, #1ed760)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", textAlign: "center" },
  configSubtitle: { textAlign: "center", opacity: 0.5, fontSize: 13, color: "#f0ede8" },
  configSection: { display: "flex", flexDirection: "column", gap: 6 },
  configLabel: { fontSize: 12, opacity: 0.6, color: "#f0ede8" },
  configInput: { background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.12)", borderRadius: 10, padding: "12px 14px", color: "#f0ede8", fontSize: 13, fontFamily: "'DM Mono', monospace", outline: "none" },
  configLink: { fontSize: 12, color: "#1db954", textDecoration: "none", opacity: 0.8 },
  divider: { display: "flex", alignItems: "center", gap: 12, margin: "4px 0" },
  dividerText: { fontSize: 11, opacity: 0.35, whiteSpace: "nowrap", color: "#f0ede8" },
  btnPrimary: { background: "linear-gradient(135deg, #1db954, #1ed760)", border: "none", borderRadius: 12, padding: "14px 28px", color: "#000", fontFamily: "'DM Mono', monospace", fontSize: 13, fontWeight: 500, cursor: "pointer", width: "100%" },
  btnSpotify: { background: "#1db954", border: "none", borderRadius: 12, padding: "14px 28px", color: "#fff", fontFamily: "'DM Mono', monospace", fontSize: 14, fontWeight: 500, cursor: "pointer", width: "100%", display: "flex", alignItems: "center", justifyContent: "center" },
  btnSecondary: { background: "rgba(255,255,255,.06)", border: "1px solid rgba(255,255,255,.1)", borderRadius: 12, padding: "12px 20px", color: "#f0ede8", fontFamily: "'DM Mono', monospace", fontSize: 13, cursor: "pointer" },
  modalOverlay: { position: "fixed", inset: 0, background: "rgba(0,0,0,.7)", backdropFilter: "blur(8px)", zIndex: 100, display: "flex", alignItems: "center", justifyContent: "center" },
  modal: { background: "#13131a", border: "1px solid rgba(255,255,255,.1)", borderRadius: 20, padding: "32px", maxWidth: 420, width: "90%", fontFamily: "'DM Mono', monospace", color: "#f0ede8" },
  modalTitle: { fontFamily: "'Fraunces', serif", fontSize: 20, marginBottom: 20 },
};
