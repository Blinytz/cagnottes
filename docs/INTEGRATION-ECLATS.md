# Cagnottes : euros, Bourse et taux de change

Cagnottes compte en **euros** (en centimes entiers). Les Éclats restent la
monnaie de l'écosystème : ils n'entrent dans Cagnottes que par une
**conversion explicite**, à un taux qui fluctue.

```
Éclats communs ──(conversion au taux du moment)──▶ Bourse (€) ──▶ Cagnottes (€)
   Pronos, Discipline…              définitive              versements locaux
```

Décision du 26/07/2026 : une cagnotte « Téléphone à 600 € » est parlante,
« 60 000 ✦ » ne l'est pas. La conversion introduit en plus un vrai choix —
attendre un bon taux — repris du moteur de WikiDeck.

## Le taux de change

| Paramètre | Valeur |
|---|---|
| Parité de référence | 100 ✦ = 1 € au taux ×1.00 |
| Bornes | ×0,60 à ×1,40 (100 ✦ valent 0,60 € à 1,40 €) |
| Régimes | bas (40 %), haut (40 %), neutre (20 %), 20 min à 1 h 30 chacun |
| Rythme | un pas toutes les 10 s, lissage + bruit |
| Hors ligne | le temps écoulé est rejoué au retour (jusqu'à 7 jours) |
| Courbe | 6 h · 12 h · 24 h · 2 j · 4 j · 7 j |

Le taux est **local à l'appareil**, comme dans WikiDeck. Sur 7 jours simulés il
parcourt toute la plage, avec une moyenne de 0,995 et 38 % du temps en zone haute.

## Ce qui est livré

| Fichier | Rôle |
|---|---|
| `js/bourse-taux.js` | Moteur du taux : régimes, rattrapage hors-ligne, historique, courbe SVG, conversion en centimes. |
| `js/bourse.js` | La Bourse : conversion Éclats → euros (dépense réelle d'Éclats + crédit en euros), journal des conversions. |
| `js/bascule-euros.js` | Passage v2 (Éclats) → v3 (euros), fonctions pures. |
| `js/eclats-local.js` | Journal local générique (clé paramétrable, `crediter` ajouté) — sert de Bourse. |
| `js/eclats-cagnottes.js` | Journal des versements, branché sur la Bourse. |
| `js/eclats-registre.js` | Client du registre commun (Supabase), pour les conversions. |
| `js/main.js` | Assemblage. **Seul endroit qui décide d'où vient l'argent.** |
| `tests/` | 59 tests (`node --test`). |

## Règles d'une conversion

- Elle **dépense réellement des Éclats** (`eclats_spend`, confirmée par le serveur).
- **Tu choisis le montant** : une part de tes Éclats, pas forcément tout.
- Le **taux est figé au moment de la demande**. Un rejeu après une panne réseau
  applique le taux d'origine — sinon il suffirait d'attendre une hausse pour
  s'enrichir sur un échec.
- Les euros crédités portent sur les Éclats **réellement dépensés** (le registre
  plafonne au solde disponible).
- Elle est **définitive** : convertir bas puis annuler haut fabriquerait des
  Éclats. Aucune annulation n'est proposée.
- Elle est **idempotente** : double clic, rejeu ou rechargement ne convertissent
  jamais deux fois.

## La bascule vers les euros

Détectée au démarrage si l'état est en version 2. Elle **rembourse d'abord au
registre commun tous les versements faits en Éclats**, puis réétiquette l'état.
Rien n'est réécrit tant que les remboursements ne sont pas confirmés : mieux vaut
une bascule reportée que des Éclats perdus. Une copie de l'état « tout en Éclats »
est conservée dans `cagnottes_sauvegarde_eclats_v2`.

Les cagnottes gardent nom, image, objectif, palier et ordre ; elles repartent
vides. La Bourse démarre à 0 € : c'est à toi de convertir quand le taux te plaît.

> Détail utile : la bascule précédente valait 1 € = 100 ✦, donc **1 Éclat = 1
> centime**. Les objectifs gardent leur valeur numérique — 60 000 ✦ *sont*
> 600,00 €. Aucun arrondi, aucune perte.

## Dans l'interface

- Le bandeau haut affiche la **Bourse en euros** et le total engagé.
- L'onglet **Change** montre le taux en direct, sa zone (haute/basse/neutre), la
  courbe avec choix de fenêtre, tes Éclats disponibles et leur équivalent au taux
  courant, le champ de conversion avec **aperçu en direct**, et l'historique des
  conversions.
- Verser dans une cagnotte puise dans la **Bourse** : plus aucune dépendance au
  réseau pour l'usage quotidien. Seule la conversion parle au registre commun.
- Le « − » annule le dernier versement encore engagé, pour son montant exact.

## Garde-fous

- Aucune clé `service_role` dans le navigateur.
- Les euros sont des **centimes entiers** : pas de dérive de flottant.
- La conversion arrondit **à l'inférieur** — jamais un centime offert.
- Le montant d'une cagnotte est dérivé de ses versements, jamais recopié.
- Une opération non confirmée n'est **jamais** présentée comme comptabilisée.
