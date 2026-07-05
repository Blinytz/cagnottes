# 💰 Cagnottes

PWA personnelle pour se récompenser financièrement de petits efforts : chaque effort alimente des **cagnottes d'épargne** dédiées à des récompenses concrètes (un objet, une sortie…), depuis une **Bourse** centrale qui représente l'argent réellement disponible.

100 % vanilla (HTML/CSS/JS), sans build, sans backend : les données vivent dans le `localStorage` du navigateur, avec export/import JSON pour les sauvegardes.

## Fonctionnalités

- **Bourse centrale** : solde (peut être négatif), mouvements manuels avec note, historique complet, graphique d'évolution. Bandeau de rappel du solde sur tous les écrans.
- **Cagnottes** : image (emoji, URL ou photo uploadée), objectif, palier +/− rapide, montants libres avec note, description éditable, graphique de progression (7 j / 30 j / depuis le début), estimation « objectif atteint dans X jours ».
- **Règles de transfert** : alimenter une cagnotte puise dans la Bourse (blocage si vide/négative, transfert partiel automatique si solde insuffisant) ; retirer reverse à la Bourse ; une cagnotte ne descend jamais sous 0 €.
- **Validation** : à 100 %, bouton « Valider » → popup de félicitations animée → archivage. Réactivation possible depuis les archives.
- **Accueil** : tri automatique par % d'avancement, ou réordonnancement manuel par glissé-déposé (persistant).
- **Statistiques** : moyenne/jour, temps moyen de clôture, totaux, cagnotte la plus rapide, jour de la semaine le plus généreux, évolution globale.
- **Réglages** : export JSON complet (Bourse incluse) et import avec confirmation.
- **PWA** : installable sur Android (mode standalone), fonctionne entièrement hors-ligne (service worker cache-first).

## Déploiement sur GitHub Pages

1. Pousser ce dépôt sur GitHub (`blinytz`) :
   ```bash
   git remote add origin https://github.com/<ton-user>/blinytz.git
   git push -u origin main
   ```
2. Sur GitHub : **Settings → Pages → Source : Deploy from a branch → Branch : `main` / `(root)`** → Save.
3. L'app est servie sur `https://<ton-user>.github.io/blinytz/`. Tous les chemins sont relatifs : aucun réglage supplémentaire.
4. Sur Android (Chrome) : ouvrir l'URL → menu ⋮ → **« Ajouter à l'écran d'accueil »** / **« Installer l'application »**.

> ⚠️ À chaque mise à jour du code, incrémenter `CACHE_VERSION` dans [sw.js](sw.js) pour que les utilisateurs reçoivent la nouvelle version.

## Test en local

Un simple serveur statique suffit (le service worker exige http://localhost ou https) :

```bash
python -m http.server 8000
# → http://localhost:8000
```

## Structure

| Fichier | Rôle |
|---|---|
| `index.html` | Coquille de l'app (header Bourse, nav, conteneurs) |
| `css/style.css` | Thème unique « atelier d'épargne » |
| `js/utils.js` | Formatage, dates, échappement HTML |
| `js/store.js` | État, persistance localStorage, logique métier (transferts, historiques journaliers, stats, export/import) |
| `js/charts.js` | Graphiques en ligne sur canvas, sans dépendance |
| `js/views.js` | Rendu des 6 écrans, modales, confettis, drag & drop |
| `js/app.js` | Routeur hash, délégation d'événements, toasts, enregistrement du SW |
| `manifest.json`, `sw.js`, `icons/` | PWA installable + hors-ligne |

## Évolutions prévues

Chaque mouvement de Bourse porte un champ `source` (`'manuel'` pour l'instant) : de futures intégrations (API, imports automatiques d'autres apps) pourront créditer/débiter la Bourse en ajoutant simplement une nouvelle valeur de source, sans refonte du modèle.
