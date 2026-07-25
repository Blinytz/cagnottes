# ✦ Cagnottes

PWA personnelle pour se récompenser de petits efforts : chaque effort alimente des **cagnottes** dédiées à des récompenses concrètes (un objet, une sortie…), payées en **Éclats**, la monnaie commune de l'écosystème.

100 % vanilla (HTML/CSS/JS), sans build, sans backend : les données vivent dans le `localStorage` du navigateur, avec export/import JSON pour les sauvegardes.

## Le modèle en Éclats

Depuis le 25/07/2026, l'application ne compte plus en euros. La **Bourse locale a disparu** : Cagnottes ne crée jamais d'Éclats, elle en **dépense** et en **rend**. Les Éclats se gagnent dans les autres applications de l'écosystème (Pronos aujourd'hui, Rédac / Mémo / Discipline ensuite).

- **Un versement** consomme des Éclats disponibles, plafonné au solde, et n'est acquis qu'une fois **confirmé par le registre**. Une opération non confirmée n'est jamais présentée comme comptabilisée.
- **Une annulation** rembourse **exactement** le versement d'origine, **une seule fois**. Le registre rembourse par référence, en tout-ou-rien : le bouton « − » annule donc le **dernier versement encore engagé**, pour son montant exact, et chaque versement peut aussi être annulé depuis la liste des mouvements.
- **Le solde n'est jamais stocké** côté client : il est la somme d'un journal. De même, le montant d'une cagnotte n'est pas une valeur enregistrée mais la somme de ses versements non remboursés — d'où l'impossibilité structurelle d'une divergence entre l'affichage et la comptabilité.
- **Valider une cagnotte** n'écrit rien : les Éclats ont déjà été dépensés au fil des versements ; la cagnotte cesse simplement d'être annulable.

### Registre local, puis registre commun

Le solde vient aujourd'hui d'un registre **local** ([js/eclats-local.js](js/eclats-local.js)), en attendant le raccordement au **registre commun** de l'écosystème ([js/eclats-registre.js](js/eclats-registre.js), projet Supabase partagé avec Pronos). Les deux exposent **le même contrat** — mêmes signatures, mêmes garanties d'idempotence, mêmes messages d'erreur — et [tests/eclats-local.test.mjs](tests/eclats-local.test.mjs) vérifie cette équivalence.

La bascule se fera en une ligne dans [js/main.js](js/main.js), sans toucher ni au Store ni à l'interface. Elle reste conditionnée à l'exécution de la migration `registre_commun.sql` et à l'ajout d'un écran de connexion — voir [docs/INTEGRATION-ECLATS.md](docs/INTEGRATION-ECLATS.md).

> Le solde d'ouverture (100 ✦) a été fixé arbitrairement et sera corrigé lors de la synchronisation avec Centrale.

### Bascule des anciennes données euro

À la première ouverture, les données en euros sont converties **une seule fois**, au taux fixe **1 € = 100 ✦**. Le taux rend tous les montants entiers sans perte, l'Éclat étant indivisible : 0,50 € → 50 ✦, 60 € → 6 000 ✦.

L'historique n'est pas recopié mais **rejoué** en versements datés (un apport devient un versement, un retrait annule les versements les plus récents), afin que le journal reconstruit obéisse aux mêmes règles que celles retenues pour l'avenir. Une copie intégrale des données euro est conservée et reste exportable depuis les Réglages.

## Fonctionnalités

- **Écran Éclats** : disponible, engagé dans les cagnottes, déjà transformé en récompenses, et répartition par application de l'écosystème — la même lecture que Centrale. Les opérations non confirmées y sont listées et rejouables.
- **Cagnottes** : image (emoji, URL ou photo uploadée), objectif, palier de versement rapide, montants libres avec note, description éditable, graphique de progression (7 j / 30 j / depuis le début), estimation « objectif atteint dans X jours ».
- **Validation** : à 100 %, bouton « Valider » → popup de félicitations animée → archivage. Réactivation possible depuis les archives.
- **Accueil** : tri automatique par % d'avancement, ou réordonnancement manuel par glissé-déposé (persistant).
- **Statistiques** : moyenne versée/jour, temps moyen de clôture, totaux, cagnotte la plus rapide, jour de la semaine le plus généreux, évolution globale.
- **Réglages** : export JSON complet (état, journal des versements et journal d'Éclats) et import avec confirmation — une sauvegarde antérieure à la bascule est convertie automatiquement au même taux.
- **PWA** : installable sur Android (mode standalone), fonctionne entièrement hors-ligne (service worker cache-first).

> ⚠️ L'export contient le journal des versements : sans lui, les versements ne sont plus annulables, les clés d'idempotence étant locales. C'est aussi pourquoi « Effacer toutes les données » le signale explicitement.

## Tests

```bash
node --test "tests/*.test.mjs"
```

| Fichier | Couvre |
|---|---|
| `tests/eclats.test.mjs` | Contrôleur de versements contre un faux registre : plafonnement, double clic, rejeu réseau, remboursement exactement-une-fois |
| `tests/eclats-local.test.mjs` | Équivalence du registre local avec la sémantique SQL du registre commun |
| `tests/bascule.test.mjs` | Conversion euro → Éclats : taux, rejeu LIFO de l'historique, recalage, idempotence de l'ouverture |

## Déploiement sur GitHub Pages

1. Pousser ce dépôt sur GitHub (`cagnottes`) :
   ```bash
   git push -u origin main
   ```
2. Sur GitHub : **Settings → Pages → Source : Deploy from a branch → Branch : `main` / `(root)`** → Save.
3. L'app est servie sur `https://<ton-user>.github.io/cagnottes/`. Tous les chemins sont relatifs : aucun réglage supplémentaire.
4. Sur Android (Chrome) : ouvrir l'URL → menu ⋮ → **« Ajouter à l'écran d'accueil »** / **« Installer l'application »**.

> ⚠️ À chaque mise à jour du code, incrémenter `CACHE_VERSION` dans [sw.js](sw.js) pour que les utilisateurs reçoivent la nouvelle version.

## Test en local

⚠️ **Ne pas ouvrir `index.html` par double-clic.** Un PWA doit être servi par un serveur : ouvert en `file://`, le service worker ne s'enregistre pas et les modules JavaScript sont bloqués par la politique d'origine (page blanche).

**Le plus simple (Windows) :** double-clique sur **`Lancer-Cagnottes.bat`**. Il démarre un petit serveur local et ouvre le navigateur sur l'app. Laisse la fenêtre noire ouverte pendant l'utilisation, ferme-la pour arrêter.

**À la main :**
```bash
python -m http.server 4321
```

## Structure

| Fichier | Rôle |
|---|---|
| `index.html` | Coquille de l'app (bandeau Éclats, nav, conteneurs) |
| `css/style.css` | Thème unique « atelier d'épargne » |
| `js/utils.js` | Formatage en Éclats, dates, échappement HTML, UUID |
| `js/main.js` | Point d'entrée : assemble registre + journal + Store. **Seul endroit qui décide d'où vient le solde** |
| `js/store.js` | Données métier des cagnottes, valeurs comptables dérivées du journal, stats, export/import |
| `js/eclats-local.js` | Registre d'Éclats local, au contrat du registre commun |
| `js/eclats-registre.js` | Client du registre commun Supabase (clé publique uniquement) |
| `js/eclats-cagnottes.js` | Journal des versements : source de vérité comptable |
| `js/eclats-migration.js` | Bascule euro → Éclats (fonctions pures) |
| `js/charts.js` | Graphiques en ligne sur canvas, sans dépendance |
| `js/views.js` | Rendu des 6 écrans, modales, confettis, drag & drop |
| `js/app.js` | Routeur hash, délégation d'événements, toasts, enregistrement du SW |
| `manifest.json`, `sw.js`, `icons/` | PWA installable + hors-ligne |
