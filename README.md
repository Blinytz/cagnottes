# 💶 Cagnottes

PWA personnelle pour se récompenser de petits efforts : chaque effort alimente des **cagnottes** dédiées à des récompenses concrètes (un objet, une sortie…).

100 % vanilla (HTML/CSS/JS), sans build, sans backend propre : les données vivent dans le `localStorage` du navigateur, avec export/import JSON pour les sauvegardes.

## Deux monnaies, une parité fixe

Les cagnottes sont en **euros**. Les **Éclats** sont la monnaie de l'écosystème, gagnée dans les autres applications (Pronos, Discipline…). Entre les deux, une parité fixe : **100 ✦ = 1 €**, donc 1 Éclat = 1 centime.

```
Éclats communs ◀──(100 ✦ = 1 €)──▶ Bourse (€) ──▶ Cagnottes (€)
   registre commun                  réversible      versements locaux
```

La **Bourse** est un intermédiaire volontaire : on y convertit des Éclats au fil de l'eau, puis on répartit dans les cagnottes. Verser ne parle donc jamais au réseau — seule la conversion le fait.

- **Convertir** dépense réellement des Éclats du registre commun, plafonné au solde, confirmé par le serveur. Idempotent : un double clic ou un rejeu ne convertit jamais deux fois.
- **Rendre** fait le chemin inverse, pour **tout ou partie** du solde. Seule la Bourse est reprenable : ce qui est déjà versé dans une cagnotte ne l'est pas, il faut d'abord l'en sortir (annuler un versement, ou supprimer la cagnotte — ses euros reviennent alors à la Bourse). Le registre ne sachant rembourser qu'une dépense passée et en entier — la garantie qui empêche une application de fabriquer des Éclats —, rendre 20 € sur une conversion de 50 rembourse la conversion entière puis en reconvertit aussitôt le reliquat. Ce réancrage est interne : tu demandes juste un montant.
- **Le solde n'est jamais stocké** : il est la somme d'un journal. De même, le montant d'une cagnotte n'est pas une valeur enregistrée mais la somme de ses versements non remboursés — d'où l'impossibilité structurelle d'une divergence entre l'affichage et la comptabilité.
- **Le « − »** annule le dernier versement encore engagé, pour son montant exact ; chaque versement est aussi annulable depuis la liste des mouvements. Il n'y a pas de retrait d'un montant arbitraire : le journal rembourse par référence, en tout-ou-rien.
- **Valider une cagnotte** n'écrit rien : les euros ont déjà quitté la Bourse au fil des versements ; la cagnotte cesse simplement d'être annulable.

Détail des règles et des garde-fous : [docs/INTEGRATION-ECLATS.md](docs/INTEGRATION-ECLATS.md).

## Fonctionnalités

- **Écran Change** : la Bourse, tes Éclats disponibles et leur équivalent en euros, la conversion et la reprise (aperçu en direct et bouton « Tout » pour chacune), l'historique des échanges dans les deux sens, et les opérations à confirmer.
- **Cagnottes** : image (emoji, URL ou photo uploadée), objectif, palier de versement rapide, montants libres avec note, description éditable, graphique de progression (7 j / 30 j / depuis le début), estimation « objectif atteint dans X jours ».
- **Validation** : à 100 %, bouton « Valider » → popup de félicitations animée → archivage. Réactivation possible depuis les archives.
- **Accueil** : tri automatique par % d'avancement, ou réordonnancement manuel par glissé-déposé (persistant).
- **Statistiques** : moyenne versée/jour, temps moyen de clôture, totaux, cagnotte la plus rapide, jour de la semaine le plus généreux, évolution globale.
- **Réglages** : export JSON complet et import avec confirmation.
- **PWA** : installable sur Android (mode standalone), fonctionne hors-ligne (service worker).

> ⚠️ L'export contient le journal des versements et les deux journaux de la Bourse. Sans eux, les versements ne sont plus annulables et les conversions plus reprenables : les clés d'idempotence sont locales. C'est aussi pourquoi « Effacer toutes les données » le signale explicitement.

## Tests

```bash
node --test "tests/*.test.mjs"
```

| Fichier | Couvre |
|---|---|
| `tests/bourse.test.mjs` | Conversion à parité fixe, plafonnement, reprise d'un montant libre, reconversion du reliquat, impossibilité de créer des Éclats, coupure réseau en cours de reprise |
| `tests/eclats.test.mjs` | Journal des versements : plafonnement, double clic, rejeu réseau, remboursement exactement-une-fois |
| `tests/eclats-local.test.mjs` | Équivalence du journal local avec la sémantique SQL du registre commun |

## Déploiement sur GitHub Pages

1. Pousser sur `main` — la publication est automatique.
2. L'app est servie sur `https://blinytz.github.io/cagnottes/`. Tous les chemins sont relatifs.
3. Sur Android (Chrome) : ouvrir l'URL → menu ⋮ → **« Ajouter à l'écran d'accueil »**.

> ⚠️ À chaque mise à jour du code, incrémenter `CACHE_VERSION` dans [sw.js](sw.js) pour que la nouvelle version soit reçue.

## Test en local

⚠️ **Ne pas ouvrir `index.html` par double-clic.** Un PWA doit être servi par un serveur : en `file://`, le service worker ne s'enregistre pas et les modules JavaScript sont bloqués par la politique d'origine (page blanche).

**Le plus simple (Windows) :** double-clique sur **`Lancer-Cagnottes.bat`**.

**À la main :**
```bash
python -m http.server 4321
```

## Structure

| Fichier | Rôle |
|---|---|
| `index.html` | Coquille de l'app (bandeau à deux monnaies, nav, conteneurs) |
| `css/style.css` | Thème unique « atelier d'épargne » |
| `js/utils.js` | Formatage euros/Éclats, dates, échappement HTML, UUID |
| `js/main.js` | Point d'entrée : assemble Bourse, versements et Store. **Seul endroit qui décide d'où vient l'argent** |
| `js/store.js` | Données métier des cagnottes, valeurs comptables dérivées du journal, stats, export/import |
| `js/bourse.js` | Bourse en euros : conversion, reprise d'un montant libre, parité fixe |
| `js/eclats-local.js` | Journal local générique (clé paramétrable), au contrat du registre commun |
| `js/eclats-registre.js` | Client du registre commun Supabase (clé publique uniquement) |
| `js/eclats-cagnottes.js` | Journal des versements : source de vérité comptable |
| `js/bascule-euros.js` | Bascule « tout en Éclats » → euros (fonctions pures) |
| `js/charts.js` | Graphiques en ligne sur canvas, sans dépendance |
| `js/views.js` | Rendu des 6 écrans, modales, confettis, drag & drop |
| `js/app.js` | Routeur hash, délégation d'événements, toasts, enregistrement du SW |
| `manifest.json`, `sw.js`, `icons/` | PWA installable + hors-ligne |
