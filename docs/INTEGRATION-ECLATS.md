# Cagnottes : euros, Bourse et Éclats

Cagnottes compte en **euros** (en centimes entiers). Les Éclats restent la
monnaie de l'écosystème : ils n'entrent dans Cagnottes que par une
**conversion explicite**, à la parité fixe **100 ✦ = 1 €**.

```
Éclats communs ◀──(100 ✦ = 1 €)──▶ Bourse (€) ──▶ Cagnottes (€)
   Pronos, Discipline…              réversible        versements locaux
```

La Bourse est un **intermédiaire volontaire** : on y convertit au fil de l'eau,
puis on répartit dans les cagnottes. Verser ne parle donc jamais au réseau —
seule la conversion le fait. Et ce qu'on n'a pas versé peut repartir en Éclats.

La parité étant fixe, **1 Éclat = 1 centime** : il n'y a aucun calcul de
conversion, seulement un changement d'unité. Une cagnotte « Téléphone à 600 € »
reste parlante là où « 60 000 ✦ » ne l'était pas.

## Ce qui est livré

| Fichier | Rôle |
|---|---|
| `js/bourse.js` | La Bourse : conversion Éclats → euros, reprise euros → Éclats, journal des conversions. Porte la parité. |
| `js/eclats-local.js` | Journal local générique (clé paramétrable) — sert de Bourse. |
| `js/eclats-cagnottes.js` | Journal des versements, branché sur la Bourse. |
| `js/eclats-registre.js` | Client du registre commun (Supabase), pour les conversions. |
| `js/bascule-euros.js` | Passage v2 (Éclats) → v3 (euros), fonctions pures. |
| `js/main.js` | Assemblage. **Seul endroit qui décide d'où vient l'argent.** |
| `tests/` | 38 tests (`node --test "tests/*.test.mjs"`). |

## Règles d'une conversion

- Elle **dépense réellement des Éclats** (`eclats_spend`, confirmée par le serveur).
- **Tu choisis le montant** : une part de tes Éclats, pas forcément tout.
- Les euros crédités portent sur les Éclats **réellement dépensés** (le registre
  plafonne au solde disponible).
- Elle est **idempotente** : double clic, rejeu ou rechargement ne convertissent
  jamais deux fois.

## Rendre des euros = défaire une conversion

Le registre commun ne sait pas créditer des Éclats, seulement **rembourser une
dépense passée** (`eclats_refund`). C'est une garantie, pas une gêne : elle rend
structurellement impossible qu'une application fabrique des Éclats.

Une reprise porte donc sur une **conversion entière**, et seulement tant que la
Bourse détient encore la somme correspondante — le reste étant engagé dans des
cagnottes. Pour libérer une conversion, il faut d'abord annuler un versement.
D'où le conseil affiché à l'écran : convertir au fil de l'eau, en petits
montants, qui se reprennent plus facilement.

L'ordre des opérations est délibéré : les euros quittent d'abord la Bourse
(local, sûr), puis les Éclats sont rendus au registre (réseau, faillible). Si le
réseau lâche entre les deux, les euros sont « en transit », l'opération est
signalée dans **À confirmer** et rejouable — le remboursement étant idempotent,
rejouer ne rend jamais deux fois. L'ordre inverse aurait pu faire coexister les
euros **et** les Éclats : de la valeur créée à partir de rien.

## La bascule vers les euros

Détectée au démarrage si l'état est en version 2. Elle **rembourse d'abord au
registre commun tous les versements faits en Éclats**, puis réétiquette l'état.
Rien n'est réécrit tant que les remboursements ne sont pas confirmés : mieux vaut
une bascule reportée que des Éclats perdus. Une copie de l'état « tout en Éclats »
est conservée dans `cagnottes_sauvegarde_eclats_v2`.

Les cagnottes gardent nom, image, objectif, palier et ordre ; elles repartent
vides. La Bourse démarre à 0 € : c'est à toi de convertir.

> Les objectifs gardent leur valeur numérique — 60 000 ✦ *sont* 600,00 €.
> Aucun arrondi, aucune perte.

## Dans l'interface

- Le bandeau haut affiche les deux monnaies, jamais confondues : les **Éclats**
  du registre commun à gauche, la **Bourse en euros** à droite.
- L'onglet **Change** montre la Bourse, tes Éclats disponibles et leur équivalent,
  le champ de conversion avec aperçu en direct, la liste des conversions
  reprenables, et l'historique.
- Verser dans une cagnotte puise dans la **Bourse** : aucune dépendance au réseau
  pour l'usage quotidien.
- Le « − » annule le dernier versement encore engagé, pour son montant exact.

## Garde-fous

- Aucune clé `service_role` dans le navigateur.
- Les euros sont des **centimes entiers** : pas de dérive de flottant.
- Le montant d'une cagnotte est dérivé de ses versements, jamais recopié.
- Une opération non confirmée n'est **jamais** présentée comme comptabilisée.
- L'export embarque les **deux** journaux de la Bourse (les euros et les
  conversions qui les ont produits) ; l'import les restaure **ensemble**. Séparés,
  ils décriraient un solde sans origine.
