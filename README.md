# 🍿 Popcorn BG

Web-app mobile ([**pierre-lebihan.github.io/popcorn-bg**](https://pierre-lebihan.github.io/popcorn-bg/)) et scripts TMDB/IMDb pour découvrir et marquer des films/séries disponibles en streaming abonnement (Netflix, Prime Video, Apple TV, etc.), avec **suivi et notation IMDb par saison et par épisode** pour les séries.

## Prérequis

```bash
pip install -r requirements.txt
cp .env.example .env
# Éditer .env avec tes clés TMDB, TMDB_WATCH_REGION et TMDB_WATCH_PROVIDER_IDS
```

> Les notes et nombres de votes IMDb (globaux et par saison) sont récupérés automatiquement depuis les datasets officiels quotidiens d'IMDb (`title.ratings.tsv.gz` et `title.episode.tsv.gz`), mis en cache 24h dans `.cache/` (aucune clé OMDb ni limite de requêtes).

## Scripts

### Marquer (ou démarquer) des films et des saisons de séries

```bash
# Films
python scripts/tmdb_marquer_vus.py "Dangal" "Le Tombeau des lucioles"
python scripts/tmdb_marquer_vus.py "Parasite|2019"

# Séries — marque toutes les saisons sorties à ce jour (les futures saisons remonteront toutes seules !)
python scripts/tmdb_marquer_vus.py --series "Peaky Blinders|2013"

# Séries — marquer uniquement certaines saisons vues
python scripts/tmdb_marquer_vus.py --series "Stranger Things" --seasons 1-4
python scripts/tmdb_marquer_vus.py --series "Stranger Things|1-4" "Better Call Saul|2015|1-3"

# Séries à épisodes indépendants / sitcoms — picorer des épisodes précis sans cocher toute la saison
python scripts/tmdb_marquer_vus.py --series "Black Mirror|S7E1,S7E5,S7E6" "Rick et Morty|S7E5,S7E10"

# Séries — masquer définitivement (ne remontera jamais, même futures saisons : manga lu, abandon...)
python scripts/tmdb_marquer_vus.py --series --lock "Vinland Saga" "Berserk|1997" "Monster|2004"

# Démarquer certaines saisons (ex. la dernière saison pas encore vue)
python scripts/tmdb_marquer_vus.py --series --unwatch "Rick and Morty" --seasons 8-9

# Migrer les séries déjà notées globalement sur TMDB vers le suivi par saison
python scripts/tmdb_marquer_vus.py --migrate-series
```

### Afficher le TOP 50 (non vus / saisons restantes à voir, triés par IMDb)

```bash
python scripts/tmdb_top50.py                         # films uniquement (défaut)
python scripts/tmdb_top50.py --serie                 # séries (encart 'Saisons à rattraper' + Top 50 non vues)
python scripts/tmdb_top50.py --film --serie          # les deux
python scripts/tmdb_top50.py -e "Rick et Morty" "Black Mirror"  # guide des épisodes non vus triés par note IMDb
python scripts/tmdb_top50.py -e "Black Mirror" --by-season      # guide des épisodes non vus dans l'ordre des saisons
python scripts/tmdb_top50.py --markdown              # sortie Markdown avec liens cliquables
python scripts/tmdb_top50.py --min-imdb-votes 5000   # seuil min de votes IMDb (défaut: 3000)
python scripts/tmdb_top50.py --refresh-cache         # forcer la mise à jour du cache 24h
python scripts/tmdb_top50.py --all                   # inclure les films/séries entièrement vus (✅)
python scripts/tmdb_top50.py --list-providers        # lister les IDs de plateformes disponibles
python scripts/tmdb_top50.py --region FR --providers 8,119,350
```

## Application Web Mobile (GitHub Pages + Supabase + TMDB)

L'application web [`docs/index.html`](docs/index.html) + [`docs/app.js`](docs/app.js) :
- Charge le catalogue public et les notes IMDb depuis [`docs/data.json`](docs/data.json) (aucune donnée personnelle ni clé privée dans le dépôt public).
- Authentifie uniquement **Pierre** (`l.bihan.pierre@gmail.com`) et **Vilma** (`krstevska.vilma95@gmail.com`) via **Google OAuth** sur Supabase (`popcorn-bg`, ref `ykqwnuuuveeqgfuspkfz`), toute autre inscription étant bloquée en base (`trg_popcorn_auth_allowlist`).
- Passe par l'Edge Function [`supabase/functions/popcorn/index.ts`](supabase/functions/popcorn/index.ts) pour lire les « vus » des deux membres du foyer et cocher/décocher **films, séries entières, saisons ou épisodes** sur le compte de la personne connectée.

```bash
# Mettre à jour le catalogue statique (300 films + 300 séries + notes par saison & épisode)
python scripts/export_web.py

# Tester en local (puis ouvrir http://localhost:8080)
python -m http.server -d docs 8080
```

### Section 📚 Lecture (mangas & webtoons)

- [`scripts/export_books.py`](scripts/export_books.py) génère `docs/books.json` : les mangas (🇯🇵) et webtoons / manhwa / manhua (🇰🇷 🇨🇳) les mieux notés sur [AniList](https://anilist.co), dans un seul classement filtrable Mangas / Webtoons. API publique, aucune clé ; seuil de lecteurs plus bas pour les webtoons.
- Les lectures (lu, en cours jusqu'au tome N, masqué) sont enregistrées **sur le compte AniList de chacun** : bouton « Relier mon compte AniList » dans l'app (OAuth implicite, client `56254` dans `docs/config.js`). Seul le jeton AniList (valable 1 an) est stocké dans `popcorn_user_state`.

```bash
python scripts/export_books.py   # régénère docs/books.json
```

### Section 📚 Lecture (BD & comics)

Aucun site de notes BD fiable n'a d'API ouverte : le classement BD & comics repose sur un **référentiel figé**, mis à jour à la main de temps en temps.

- [`scripts/build_bd_referentiel.py`](scripts/build_bd_referentiel.py) est la source lisible : titres, mode (série à suivre, albums indépendants, one-shot) et citations (Fauve d'or et Prix de la série d'Angoulême, Grand Prix ACBD, Eisner, top 100 Moustique…). Il génère [`data/bd_referentiel.json`](data/bd_referentiel.json) avec sa date de mise à jour (`UPDATED_AT`), affichée dans l'app.
- [`scripts/export_bd.py`](scripts/export_bd.py) génère `docs/bd.json` chaque nuit : score de consensus (points par citation, une même source compte au plus 2 fois) + bonus selon la note des lecteurs [Hardcover](https://hardcover.app) (secret `HARDCOVER_TOKEN`, optionnel, à recréer chaque 1er janvier). Paliers : Chef-d'œuvre ≥ 8, Incontournable ≥ 4.
- Les lectures BD sont stockées dans Supabase (`popcorn_user_state.bd`) : lu / en cours jusqu'au tome N pour les séries, coche album par album pour les albums indépendants (Astérix, Tintin, Gaston…).

```bash
python scripts/build_bd_referentiel.py          # après avoir modifié le référentiel
HARDCOVER_TOKEN=... python scripts/export_bd.py  # régénère docs/bd.json
```

### Section 🎮 Jeux (Game Pass cloud)

- [`scripts/export_games.py`](scripts/export_games.py) génère `docs/games.json` chaque nuit : tous les jeux **Xbox Game Pass jouables en cloud** dans le marché `GAMEPASS_MARKET` (variable du dépôt, `PL` par défaut, le pays du VPN : le cloud n'est pas vendu en Bulgarie), avec l'**offre minimum** qui inclut chaque jeu (Essential ⊂ Premium ⊂ Ultimate) et les jeux qui quittent bientôt le Game Pass.
- Sources : les listes publiques de xbox.com/play (`catalog.gamepass.com`, non documentées, sans clé) et `displaycatalog.mp.microsoft.com` pour les fiches ; la note vient des **avis Steam** (% positif pondéré par le nombre d'avis, façon SteamDB), sinon de la note presse IGDB, sinon du Store Xbox. Les avis Steam sont réutilisés depuis le `games.json` publié et rafraîchis tous les 7 jours.
- **IGDB (optionnel)** pour la durée de jeu et la note presse : créer une application sur [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) puis ajouter les secrets `TWITCH_CLIENT_ID` et `TWITCH_CLIENT_SECRET` au dépôt.
- Les jeux joués / en cours / masqués sont stockés dans Supabase (`popcorn_user_state.games`), action `set_game` de l'Edge Function.

```bash
GAMEPASS_MARKET=PL python scripts/export_games.py  # régénère docs/games.json
```

Le workflow GitHub Actions [`.github/workflows/pages.yml`](.github/workflows/pages.yml) déploie automatiquement `./docs` sur GitHub Pages et régénère `docs/data.json` chaque nuit (05h30 UTC) si les secrets `TMDB_API_KEY` et `TMDB_SESSION_ID` sont configurés sur le dépôt.
