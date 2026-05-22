# SpotiLive

Votre lecture Spotify en temps réel : bio de l'artiste, explication de la chanson, anecdotes en français, et statistiques d'écoute.

---

## Déploiement depuis Android (sans PC)

### Étape 1 — Créer le repo GitHub

1. Allez sur [github.com](https://github.com) et connectez-vous
2. Appuyez sur **+** → **New repository**
3. Nom : `spotilive`
4. Cochez **Public** (nécessaire pour Netlify gratuit)
5. Cochez **Add a README file**
6. Appuyez sur **Create repository**

### Étape 2 — Uploader les fichiers

Dans votre repo GitHub, appuyez sur **Add file** → **Upload files**, et uploadez **tous les fichiers** de ce ZIP en respectant la structure suivante :

```
spotilive/
├── index.html
├── package.json
├── vite.config.js
├── netlify.toml
└── src/
    ├── main.jsx
    └── App.jsx
```

> ⚠️ Pour le dossier `src/`, GitHub mobile ne gère pas bien les sous-dossiers.
> Astuce : uploadez d'abord les fichiers racine, puis créez `src/main.jsx` et `src/App.jsx` via **Add file** → **Create new file** en tapant `src/main.jsx` comme nom.

### Étape 3 — Connecter Netlify

1. Allez sur [netlify.com](https://netlify.com) et créez un compte (gratuit)
2. Appuyez sur **Add new site** → **Import an existing project**
3. Choisissez **GitHub** et autorisez l'accès
4. Sélectionnez votre repo `spotilive`
5. Netlify détecte automatiquement la config — appuyez sur **Deploy site**
6. Attendez ~2 minutes → votre URL apparaît (ex: `https://spotilive-abc123.netlify.app`)

### Étape 4 — Configurer Spotify

1. Allez sur [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard)
2. Ouvrez votre app Spotify
3. **Settings** → **Redirect URIs** → ajoutez votre URL Netlify (ex: `https://spotilive-abc123.netlify.app`)
4. Sauvegardez

### Étape 5 — Utiliser SpotiLive

1. Ouvrez votre URL Netlify
2. Entrez votre **Spotify Client ID** (visible dans votre dashboard Spotify)
3. Entrez votre **Last.fm API Key** et **username** (optionnel)
4. Appuyez sur **Continuer** puis **Se connecter avec Spotify**
5. Lancez une musique sur Spotify → SpotiLive s'active !

---

## Ce que fait SpotiLive

- 🎵 **En cours** : pochette, progression, popularité, bio artiste, explication de la chanson, anecdotes (générés par Claude en français)
- 📊 **Statistiques** : top titres et artistes des 4 dernières semaines, profil Last.fm
- 🕐 **Historique** : vos 10 dernières écoutes scrobblées

---

## Technologies

- React 18 + Vite
- Spotify Web API (OAuth 2.0 PKCE)
- Last.fm API
- Anthropic Claude API (bio et anecdotes)
