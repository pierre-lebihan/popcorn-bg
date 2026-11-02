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

Le workflow GitHub Actions [`.github/workflows/pages.yml`](.github/workflows/pages.yml) déploie automatiquement `./docs` sur GitHub Pages et régénère `docs/data.json` chaque nuit (05h30 UTC) si les secrets `TMDB_API_KEY` et `TMDB_SESSION_ID` sont configurés sur le dépôt.
