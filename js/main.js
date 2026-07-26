// Point d'entrée : assemble le registre d'Éclats, le journal des versements et
// le Store, puis démarre l'application.
//
// C'est le SEUL endroit qui décide d'où vient le solde :
//   * une session Supabase active → registre COMMUN (solde partagé avec Pronos,
//     Discipline, Centrale…) ;
//   * sinon → registre LOCAL (l'app fonctionne seule, solde d'ouverture arbitraire).
// Les deux exposent le même contrat : ni le Store ni l'interface ne changent.
//
// La connexion / déconnexion se fait depuis l'écran « Mes Éclats » (voir
// window.Registre, exposé ci-dessous, utilisé par app.js).

import { createRegistre } from './eclats-registre.js';
import { createRegistreLocal } from './eclats-local.js';
import { createCagnottesEclats } from './eclats-cagnottes.js';
import { creerStore } from './store.js';

const uid = () => U.uid();

// Client du registre commun (Supabase) : toujours instancié, car il porte la
// connexion. Il n'est utilisé comme source du solde que si une session existe.
const partage = createRegistre();
window.Registre = partage;

const registre = partage.estConnecte() ? partage : createRegistreLocal({ uid });
const eclats = createCagnottesEclats({ ledger: registre, uid });

/* Compte rendu de la bascule euro → Éclats, affiché une fois l'app prête. */
let rapportBascule = null;

window.Store = creerStore({
  eclats,
  registre,
  onMigration: (rapport) => { rapportBascule = rapport; },
});

App.init().then(() => {
  if (!rapportBascule) return;
  const r = rapportBascule;
  Views.openModal(`
    <h2 class="modal-title">Bienvenue dans les Éclats ✦</h2>
    <p>Cagnottes ne compte plus en euros. Tes données ont été converties une fois
      pour toutes, au taux <strong>1 € = ${r.taux} ✦</strong> — aucun montant n'a été
      perdu ni arrondi.</p>
    <ul class="mvt-list">
      <li class="mvt"><span class="mvt-info">${r.nbCagnottes} ${U.plural(r.nbCagnottes, 'cagnotte')} converties,
        ${r.nbVersements} ${U.plural(r.nbVersements, 'versement')} reconstitués</span></li>
      <li class="mvt"><span class="mvt-info">${U.fmtEclats(r.totalEngage)} toujours engagés dans tes cagnottes</span></li>
      <li class="mvt"><span class="mvt-info">${U.fmtEclats(r.soldeInitial)} disponibles au départ</span></li>
    </ul>
    <p class="hint">Le solde de départ est provisoire : il sera corrigé lors de la
      synchronisation avec Centrale. Ton ancienne Bourse
      (${r.soldeEuroAbandonne.toLocaleString('fr-FR', { style: 'currency', currency: 'EUR' })})
      n'est pas reportée, mais tes données en euros sont conservées et
      exportables depuis les Réglages.</p>
    <button class="btn primary wide" data-action="modal-close-home">C'est parti</button>`);
});
