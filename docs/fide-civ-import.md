# Import mensuel des joueurs FIDE CIV

Le script `scripts/fide_civ.py` utilise par défaut la liste officielle combinée
FIDE (`players_list.zip`), qui réunit les classements standard, rapide et blitz.
Il ne fusionne jamais automatiquement un joueur manuel.

## Préparer et auditer

```bash
PERIOD=2026-08
python3 scripts/fide_civ.py \
  --download \
  --period "$PERIOD" \
  --dry-run \
  --batch-size 250 \
  --output "artifacts/fide_civ_${PERIOD/-/_}.json" \
  --sql-output "supabase/seeds/fide_civ_${PERIOD/-/_}.sql"
```

Le JSON contient le rapport, tous les joueurs parsés et les trois catégories de
rapprochement. Pour comparer avec les joueurs locaux sans accès direct à la
base, passer `--existing export-joueurs.json`. Avec `DATABASE_URL`, le script
charge lui-même l'annuaire existant.

Vérifier manuellement `reconciliation.potential_duplicates` avant toute
fusion. Le score n'est qu'une suggestion et aucune instruction de fusion n'est
écrite dans le seed.

## Exécuter

Dans **Supabase Dashboard → SQL Editor**, ouvrir le fichier produit dans
`supabase/seeds/`, vérifier sa période et son checksum, puis exécuter tout le
document. Il contient `begin`, les lots d'upsert, le rapport d'audit et
`commit`; toute erreur annule donc l'import entier.

Depuis un environnement de confiance disposant de `psql`, la même opération
peut être lancée avec `--apply` et `DATABASE_URL`. Ne jamais exposer la clé
`service_role` dans ce dépôt.

Après import, ouvrir `#/joueurs`. Cette vue conserve sa pagination serveur : le
compteur doit correspondre au nombre de joueurs non fusionnés et les pages
suivantes doivent rendre la totalité de la fédération CIV.
