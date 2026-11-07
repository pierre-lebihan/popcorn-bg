"""Sonde temporaire : vérifie l'accès réel à AniList et SensCritique depuis GitHub Actions."""
import json
import re
import requests

UA = {"User-Agent": "popcorn-bg/1.0 (+https://github.com/pierre-lebihan/popcorn-bg)"}

def show(label, r, n=1500):
    print(f"\n===== {label} → HTTP {r.status_code}")
    print(r.text[:n])

q = """{Page(perPage:3){media(type:MANGA,countryOfOrigin:"KR",sort:SCORE_DESC,popularity_greater:20000){
 id title{romaji english native} format averageScore meanScore popularity volumes chapters status countryOfOrigin
 coverImage{large} genres startDate{year} siteUrl isAdult}}}"""
show("anilist", requests.post("https://graphql.anilist.co", json={"query": q}, headers=UA, timeout=30))

intro = "{__schema{queryType{fields{name args{name type{name kind ofType{name}}}}}}}"
r = requests.post("https://apollo.senscritique.com/", json={"query": intro}, headers={**UA, "Content-Type": "application/json"}, timeout=30)
show("sc introspection", r, 6000)

for url in ["https://www.senscritique.com/bd", "https://www.senscritique.com/bd/blacksad/486463",
            "https://www.senscritique.com/top/resultats/les_meilleures_bandes_dessinees/1"]:
    try:
        r = requests.get(url, headers=UA, timeout=30)
        print(f"\n===== GET {url} → {r.status_code} len={len(r.text)}")
        m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', r.text, re.S)
        if m:
            d = json.loads(m.group(1))
            s = json.dumps(d)[:5000]
            print(s)
        else:
            print(r.text[:800])
    except Exception as e:
        print(url, e)
