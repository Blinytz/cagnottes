'use strict';

/* Toasts (notifications éphémères) — global, utilisé aussi par le Store */
function toast(msg, type = 'info') {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = msg;
  root.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 400);
  }, type === 'error' ? 5200 : 3200);
}

const App = (() => {

  /* ---------- Routage par hash ---------- */

  function parseRoute() {
    const h = location.hash.replace(/^#\/?/, '');
    const [seg, id] = h.split('/');
    if (seg === 'cagnotte' && id) return { name: 'cagnotte', id };
    if (['stats', 'archives', 'eclats', 'reglages'].includes(seg)) return { name: seg };
    return { name: 'home' };
  }

  function render() {
    const route = parseRoute();
    const viewEl = document.getElementById('view');
    const html = {
      home: () => Views.viewHome(),
      cagnotte: () => Views.viewCagnotte(route.id),
      stats: () => Views.viewStats(),
      archives: () => Views.viewArchives(),
      eclats: () => Views.viewEclats(),
      reglages: () => Views.viewReglages()
    }[route.name]();
    viewEl.innerHTML = html;
    updateHeader();
    updateNav(route);
    Views.afterRender(route);
  }

  /* Bandeau Éclats persistant : disponible temps réel + total engagé */
  function updateHeader() {
    const disponible = Store.soldeDisponible();
    const el = document.getElementById('eclats-header');
    el.classList.toggle('vide', disponible <= 0);
    el.querySelector('.eh-solde').textContent = U.fmtEclats(disponible);
    el.querySelector('.eh-engage').textContent = `${U.fmtEclats(Store.totalEngage())} engagés`;
  }

  function updateNav(route) {
    document.querySelectorAll('#bottom-nav a').forEach(a => {
      a.classList.toggle('active', a.dataset.route === route.name);
    });
  }

  /* ---------- Actions +/− ---------- */

  async function stepPlus(id) {
    const c = Store.getCagnotte(id);
    if (!c) return;
    const res = await Store.alimenter(id, c.palier);
    if (!res.ok) return signalerEchecVersement(res);
    if (res.ajuste) {
      toast(`⚖️ Éclats insuffisants : seulement <strong>${U.fmtEclats(res.effectif)}</strong> versés (au lieu de ${U.fmtEclats(c.palier)}).`, 'warn');
    }
    verifierObjectifAtteint(c);
  }

  async function stepMinus(id) {
    const res = await Store.retirer(id);
    if (!res.ok) {
      if (res.reason === 'cagnotte_vide') toast('Aucun versement à annuler.', 'error');
      else signalerEchecRemboursement(res);
      return;
    }
    toast(`↩︎ Versement annulé : ${U.fmtEclats(res.effectif)} rendus.`, 'info');
  }

  /*
   * Un versement non confirmé n'est JAMAIS présenté comme comptabilisé : le
   * message distingue le refus métier (rien n'a bougé) de l'incident réseau
   * (rejouable à l'identique, sans risque de double débit).
   */
  function signalerEchecVersement(res) {
    if (res.reason === 'solde_insuffisant') {
      toast('✦ Aucun Éclat disponible : le versement n’a pas été effectué.', 'error');
    } else if (res.reason === 'reseau') {
      toast('📡 Registre injoignable : le versement <strong>n’est pas comptabilisé</strong>. Tu peux le réessayer depuis l’écran Éclats.', 'error');
    } else if (res.reason === 'en_cours') {
      /* Double clic : on ignore silencieusement, le premier versement suit son cours. */
    } else if (res.reason === 'archivee') {
      toast('Cette cagnotte est validée : elle ne peut plus être alimentée.', 'error');
    } else {
      toast('Montant invalide.', 'error');
    }
  }

  function signalerEchecRemboursement(res) {
    if (res.reason === 'non_comptabilise') toast('Ce versement n’a jamais été comptabilisé : rien à rendre.', 'warn');
    else if (res.reason === 'archivee') toast('Cette cagnotte est validée : ses versements ne sont plus annulables.', 'error');
    else toast('📡 Registre injoignable : l’annulation n’a pas abouti. Réessaie dans un moment.', 'error');
  }

  function verifierObjectifAtteint(c) {
    if (c.statut === 'en_attente_validation') {
      toast(`🎯 <strong>${U.esc(c.nom)}</strong> a atteint son objectif ! Tu peux la valider.`, 'success');
    }
  }

  /* ---------- Délégation d'événements (clics) ---------- */

  document.addEventListener('click', async e => {
    const actEl = e.target.closest('[data-action]');
    if (!actEl) return;
    const action = actEl.dataset.action;
    const id = actEl.dataset.id;

    switch (action) {
      case 'goto-eclats':
        location.hash = '#/eclats';
        break;

      case 'connexion':
        ouvrirConnexion();
        break;

      case 'deconnexion':
        if (await Views.confirmDialog('Te déconnecter du registre commun ? Cagnottes repassera en <strong>mode local</strong> (solde tenu par l’app seule).', { okLabel: 'Se déconnecter' })) {
          window.Registre.deconnexion();
          location.reload();
        }
        break;

      case 'open-cagnotte':
        /* Ignore le clic s'il vient d'un bouton ou du handle de drag */
        if (e.target.closest('button') || e.target.closest('[data-drag]')) return;
        location.hash = '#/cagnotte/' + actEl.dataset.id;
        break;

      case 'step-plus': await stepPlus(id); break;
      case 'step-minus': await stepMinus(id); break;

      case 'annuler-versement': {
        e.stopPropagation();
        const v = Store.eclats.versement(id);
        if (!v) return;
        if (await Views.confirmDialog(`Annuler ce versement de <strong>${U.fmtEclats(v.amount)}</strong> ? Les Éclats retournent au registre.`, { okLabel: 'Annuler le versement' })) {
          const res = await Store.annulerVersement(id);
          if (res.ok) toast(`↩︎ ${U.fmtEclats(res.effectif)} rendus.`, 'info');
          else signalerEchecRemboursement(res);
        }
        break;
      }

      case 'reprendre-versement': {
        const res = await Store.eclats.reprendre(id);
        await Store.rafraichirSolde();
        App.render();
        if (res.ok) toast(`✅ Versement confirmé : ${U.fmtEclats(res.amount)}.`, 'success');
        else signalerEchecVersement(res);
        break;
      }

      case 'new-cagnotte': Views.cagnotteFormModal(); break;
      case 'edit-cagnotte': Views.cagnotteFormModal(Store.getCagnotte(id)); break;

      case 'delete-cagnotte': {
        const c = Store.getCagnotte(id);
        if (!c) return;
        const extra = (c.montantActuel > 0 && c.statut !== 'archivée')
          ? ` Les ${U.fmtEclats(c.montantActuel)} qu'elle contient retourneront au registre.` : '';
        if (await Views.confirmDialog(`Supprimer définitivement « ${U.esc(c.nom)} » ?${extra}`, { danger: true, okLabel: 'Supprimer' })) {
          const res = await Store.deleteCagnotte(id);
          if (res.ok) {
            toast(res.rendus ? `Cagnotte supprimée · ${U.fmtEclats(res.rendus)} rendus.` : 'Cagnotte supprimée.');
            location.hash = '#/';
          } else if (res.reason === 'remboursement_incomplet') {
            toast('📡 Registre injoignable : la cagnotte n’a pas été supprimée pour ne perdre aucun Éclat. Réessaie dans un moment.', 'error');
          }
        }
        break;
      }

      case 'valider-cagnotte': {
        const c = Store.getCagnotte(id);
        if (Store.validerCagnotte(id).ok) Views.celebrate(c);
        break;
      }

      case 'reactiver-cagnotte': {
        e.stopPropagation();
        Store.reactiverCagnotte(id);
        toast('♻️ Cagnotte réactivée !', 'success');
        location.hash = '#/';
        break;
      }

      case 'reset-ordre':
        Store.resetOrdre();
        break;

      case 'set-range': {
        const key = actEl.closest('[data-range-key]').dataset.rangeKey;
        Views.ranges[key] = actEl.dataset.range;
        render();
        break;
      }

      case 'export-data':
        telecharger(Store.exportJSON(), `cagnottes-sauvegarde-${U.todayKey()}.json`);
        toast('💾 Sauvegarde téléchargée.', 'success');
        break;

      case 'export-euro': {
        const brut = localStorage.getItem('cagnottes_sauvegarde_euro_v1');
        if (!brut) return toast('Aucune copie en euros conservée.', 'error');
        telecharger(brut, `cagnottes-avant-eclats-${U.todayKey()}.json`);
        toast('💾 Copie en euros téléchargée.', 'success');
        break;
      }

      case 'import-data':
        document.getElementById('import-file').click();
        break;

      case 'reset-data':
        if (await Views.confirmDialog(`Toutes tes données seront effacées : cagnottes, journal des versements et journal d'Éclats. <strong>Les versements ne seront plus annulables</strong> et le solde repartira du solde d'ouverture. Pense à exporter avant !`, { danger: true, okLabel: 'Tout effacer' })) {
          Store.resetAll();
          await Store.rafraichirSolde();
          render();
          toast('Données effacées.');
          location.hash = '#/';
        }
        break;

      case 'modal-close':
        if (e.target === actEl) Views.closeModal();
        break;

      case 'modal-close-home':
        Views.closeModal();
        location.hash = '#/';
        break;
    }
  });

  /* ---------- Connexion au registre commun ---------- */

  function ouvrirConnexion() {
    Views.openModal(`
      <h2 class="modal-title">Se connecter au registre commun ✦</h2>
      <p class="hint">Utilise le <strong>même compte que Pronos</strong>. Ton solde d'Éclats
        sera alors partagé entre toutes tes applications.</p>
      <p class="hint warn">Tes engagements de test locaux repartiront de zéro sur le vrai
        solde. Tes cagnottes (noms, objectifs) sont conservées.</p>
      <form id="form-connexion" class="form-modal">
        <label>Adresse e-mail
          <input type="email" name="email" required autocomplete="username" inputmode="email" placeholder="ton@email"></label>
        <label>Mot de passe
          <input type="password" name="motdepasse" required autocomplete="current-password" placeholder="••••••••"></label>
        <button type="submit" class="btn primary wide">Se connecter</button>
      </form>`);
  }

  function telecharger(contenu, nom) {
    const blob = new Blob([contenu], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = nom;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  /* ---------- Import de fichier JSON ---------- */

  document.addEventListener('change', async e => {
    if (e.target.id !== 'import-file') return;
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    if (await Views.confirmDialog('Importer ce fichier remplacera <strong>toutes</strong> tes données actuelles (cagnottes et Éclats). Continuer ?', { danger: true, okLabel: 'Importer' })) {
      const res = Store.importJSON(text);
      if (res.ok) {
        await Store.rafraichirSolde();
        render();
        toast(res.converti
          ? `✅ Sauvegarde en euros restaurée et convertie en Éclats (1 € = ${res.rapport.taux} ✦).`
          : '✅ Données restaurées avec succès.', 'success');
        location.hash = '#/';
      } else {
        toast(res.reason === 'json_invalide'
          ? '❌ Fichier illisible : ce n’est pas du JSON valide.'
          : '❌ Fichier invalide : structure de sauvegarde non reconnue.', 'error');
      }
    }
  });

  /* ---------- Soumission des formulaires ---------- */

  document.addEventListener('submit', async e => {
    const form = e.target;

    /* Connexion au registre commun (Supabase) */
    if (form.id === 'form-connexion') {
      e.preventDefault();
      const email = form.email.value.trim();
      const mdp = form.motdepasse.value;
      const btn = form.querySelector('button[type=submit]');
      btn.disabled = true; btn.textContent = 'Connexion…';
      try {
        await window.Registre.connexion(email, mdp);
        /* Les engagements de TEST locaux ne correspondent pas au registre commun :
           on repart de zéro sur le vrai solde (les cagnottes restent). */
        localStorage.removeItem('cagnottes_eclats_v1');
        localStorage.removeItem('cagnottes_eclats_local_v1');
        location.reload();
      } catch (err) {
        btn.disabled = false; btn.textContent = 'Se connecter';
        toast('❌ ' + U.esc(err.message || 'Connexion refusée'), 'error');
      }
      return;
    }

    /* Création / édition de cagnotte */
    if (form.id === 'form-cagnotte') {
      e.preventDefault();
      const nom = form.nom.value.trim();
      const objectif = U.parseEclats(form.objectif.value);
      const palier = U.parseEclats(form.palier.value);
      if (!nom) return toast('Le nom est obligatoire.', 'error');
      if (!(objectif > 0)) return toast('L’objectif doit être un nombre d’Éclats positif.', 'error');
      if (!(palier > 0)) return toast('Le palier doit être un nombre d’Éclats positif.', 'error');
      const modal = form.closest('.modal');
      const image = modal._image || { type: 'emoji', value: '🎁' };
      const description = form.description.value.trim();
      const id = form.dataset.id;
      if (id) {
        Store.updateCagnotte(id, { nom, objectif, palier, image, description });
        toast('✅ Cagnotte mise à jour.', 'success');
      } else {
        Store.createCagnotte({ nom, objectif, palier, image, description });
        toast(`✨ Cagnotte « ${U.esc(nom)} » créée !`, 'success');
      }
      Views.closeModal();
      return;
    }

    /* Versement d'un montant libre dans une cagnotte */
    if (form.id === 'form-montant-libre') {
      e.preventDefault();
      const id = form.dataset.id;
      const c = Store.getCagnotte(id);
      const montant = U.parseEclats(form.montant.value);
      const note = form.note.value.trim();
      if (!Number.isFinite(montant) || montant <= 0) {
        return toast('Montant invalide : indique un nombre d’Éclats positif.', 'error');
      }
      const res = await Store.alimenter(id, montant, note);
      if (!res.ok) return signalerEchecVersement(res);
      toast(res.ajuste
        ? `⚖️ Éclats insuffisants : seulement <strong>${U.fmtEclats(res.effectif)}</strong> versés (au lieu de ${U.fmtEclats(montant)}).`
        : `+${U.fmtEclats(res.effectif)} versés 💪`, res.ajuste ? 'warn' : 'success');
      verifierObjectifAtteint(c);
    }
  });

  /* Sauvegarde de la description à la volée (au blur) */
  document.addEventListener('blur', e => {
    if (e.target.id === 'cagnotte-desc') {
      Store.updateCagnotte(e.target.dataset.id, { description: e.target.value.trim() });
    }
  }, true);

  /* ---------- Initialisation ---------- */

  async function init() {
    /* Tout mouvement redessine l'écran courant + le bandeau Éclats */
    Store.subscribe(() => render());
    window.addEventListener('hashchange', render);
    window.addEventListener('resize', () => Views.afterRender(parseRoute()));

    if (Store.state._corrupted) {
      toast('⚠️ Les données sauvegardées étaient corrompues et ont été réinitialisées.', 'error');
      delete Store.state._corrupted;
    }

    await Store.rafraichirSolde();
    render();

    /* Service worker (PWA hors-ligne) */
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW non enregistré :', err));
    }
  }

  return { init, render };
})();
