'use strict';

/* Rendu des 6 écrans + modales, popup de félicitations, drag & drop */
const Views = (() => {

  const EMOJIS = ['🎁', '🎮', '📱', '💻', '🎧', '👟', '👗', '💍', '🛵', '🚗', '✈️', '🏝️',
    '🎡', '🎬', '🎸', '📚', '☕', '🍣', '🍕', '🍾', '🏋️', '⚽', '🎾', '⛷️',
    '🛍️', '🛋️', '📷', '⌚', '🚴', '🎨', '🌱', '🐶', '🐱', '💆', '🎫', '💎'];

  /* Fenêtres de graphique choisies par l'utilisateur, en mémoire de session */
  const ranges = {};
  const RANGE_DAYS = { '7j': 7, '30j': 30, 'tout': null };

  /* ---------- Helpers de rendu ---------- */

  function imgHTML(image, cls = '') {
    if (image.type === 'emoji') return `<span class="img-emoji ${cls}">${U.esc(image.value)}</span>`;
    return `<img class="img-photo ${cls}" src="${U.esc(image.value)}" alt=""
      onerror="this.outerHTML='<span class=&quot;img-emoji ${cls}&quot;>🎁</span>'">`;
  }

  function pct(c) {
    return c.objectif > 0 ? (c.montantActuel / c.objectif) * 100 : 0;
  }

  function progressHTML(c) {
    const p = pct(c);
    return `<div class="progress"><div class="progress-fill${p >= 100 ? ' full' : ''}"
      style="width:${Math.min(100, p)}%"></div></div>`;
  }

  function rangeSelectorHTML(key) {
    const cur = ranges[key] || 'tout';
    return `<div class="range-selector" data-range-key="${key}">` +
      [['7j', '7 jours'], ['30j', '30 jours'], ['tout', 'Depuis le début']]
        .map(([v, label]) => `<button class="range-btn${cur === v ? ' active' : ''}" data-action="set-range" data-range="${v}">${label}</button>`)
        .join('') + `</div>`;
  }

  function serieFor(key, histo) {
    return Store.balanceSeries(histo, RANGE_DAYS[ranges[key] || 'tout']);
  }

  /* ---------- Écran 1 : Accueil ---------- */

  function viewHome() {
    const list = Store.cagnottesEnCours();
    const soldeBourse = Store.state.bourse.solde;
    const plusBloque = soldeBourse <= 0;

    let cards;
    if (!list.length) {
      cards = `<div class="empty-state">
        <div class="empty-emoji">🪄</div>
        <h2>Aucune cagnotte pour l'instant</h2>
        <p>Crée ta première cagnotte et récompense tes petits efforts !</p>
      </div>`;
    } else {
      cards = `<div id="cagnotte-list">` + list.map(c => {
        const p = pct(c);
        const attente = c.statut === 'en_attente_validation';
        return `<article class="card cagnotte-card${attente ? ' ready' : ''}" data-id="${c.id}" data-action="open-cagnotte">
          <div class="drag-handle" data-drag title="Glisser pour réordonner">⠿</div>
          <div class="card-img">${imgHTML(c.image)}</div>
          <div class="card-body">
            <h3>${U.esc(c.nom)} ${attente ? '<span class="badge-ready">✓ Prête !</span>' : ''}</h3>
            <div class="card-amounts">
              <strong>${U.fmtEUR(c.montantActuel)}</strong>
              <span class="muted">/ ${U.fmtEUR(c.objectif)}</span>
              <span class="card-pct">${Math.round(p)}%</span>
            </div>
            ${progressHTML(c)}
          </div>
          <div class="card-actions">
            <button class="btn-step minus" data-action="step-minus" data-id="${c.id}"
              ${c.montantActuel <= 0 ? 'disabled' : ''}
              title="Retirer ${U.fmtEUR(c.palier)} (retour Bourse)">−</button>
            <button class="btn-step plus" data-action="step-plus" data-id="${c.id}"
              ${plusBloque ? 'disabled' : ''}
              title="${plusBloque ? 'Bourse vide : impossible d’alimenter' : 'Ajouter ' + U.fmtEUR(c.palier) + ' depuis la Bourse'}">+</button>
          </div>
        </article>`;
      }).join('') + `</div>`;
    }

    const avertissement = (plusBloque && list.length)
      ? `<div class="warn-banner">👛 La Bourse est ${soldeBourse < 0 ? 'en négatif' : 'vide'} :
          alimente-la pour pouvoir remplir tes cagnottes.</div>` : '';

    const triInfo = Store.state.ordreManuel && list.length > 1
      ? `<button class="link-btn" data-action="reset-ordre">↩︎ Revenir au tri automatique (% décroissant)</button>` : '';

    return `<section class="view">
      <div class="view-head">
        <h1>Mes cagnottes</h1>
      </div>
      ${avertissement}
      ${cards}
      ${triInfo}
      <button class="fab" data-action="new-cagnotte" title="Nouvelle cagnotte">+</button>
    </section>`;
  }

  /* ---------- Écran 2 : Détail d'une cagnotte (+ lecture seule archivée) ---------- */

  function viewCagnotte(id) {
    const c = Store.getCagnotte(id);
    if (!c) return `<section class="view"><p class="empty-state">Cagnotte introuvable. <a href="#/">Retour</a></p></section>`;
    const archivee = c.statut === 'archivée';
    const p = pct(c);
    const key = 'cagnotte:' + id;
    const soldeBourse = Store.state.bourse.solde;

    /* Estimation de temps */
    let estimHTML = '';
    if (!archivee) {
      const e = Store.estimation(c);
      const msg = {
        pas_assez_de_donnees: '⏳ Estimation disponible après quelques jours d’activité.',
        rythme_negatif: '📉 Rythme récent nul ou négatif — estimation impossible pour l’instant.',
        atteint: '🎉 Objectif atteint !',
      }[e.type] || `🔮 À ce rythme (${U.fmtEUR(e.moyenne)}/jour), objectif atteint dans environ <strong>${e.jours} ${U.plural(e.jours, 'jour')}</strong>.`;
      estimHTML = `<div class="estimation">${msg}</div>`;
    }

    /* Formulaires de mouvement */
    const formsHTML = archivee ? '' : `
      <div class="panel">
        <div class="step-row">
          <button class="btn-step big minus" data-action="step-minus" data-id="${c.id}" ${c.montantActuel <= 0 ? 'disabled' : ''}>− ${U.fmtEUR(c.palier)}</button>
          <button class="btn-step big plus" data-action="step-plus" data-id="${c.id}" ${soldeBourse <= 0 ? 'disabled' : ''}>+ ${U.fmtEUR(c.palier)}</button>
        </div>
        ${soldeBourse <= 0 ? `<p class="hint warn">👛 Bourse ${soldeBourse < 0 ? 'en négatif' : 'vide'} : les ajouts sont bloqués.</p>` : ''}
        <form id="form-montant-libre" data-id="${c.id}" class="montant-libre">
          <div class="field-row">
            <input type="text" name="montant" inputmode="decimal" placeholder="Montant (€)" required>
            <input type="text" name="note" placeholder="Note (optionnel)" maxlength="120">
          </div>
          <div class="field-row">
            <button type="submit" class="btn primary" data-sens="plus">Ajouter à la cagnotte</button>
            <button type="submit" class="btn secondary" data-sens="minus">Retirer → Bourse</button>
          </div>
        </form>
      </div>`;

    const valideHTML = (!archivee && c.montantActuel >= c.objectif)
      ? `<button class="btn valider" data-action="valider-cagnotte" data-id="${c.id}">🏆 Valider la cagnotte</button>` : '';

    /* Mouvements */
    const mouvements = [...c.mouvements].sort((a, b) => new Date(b.date) - new Date(a.date));
    const mvtsHTML = mouvements.length ? `<ul class="mvt-list">` + mouvements.map(m => `
      <li class="mvt">
        <span class="mvt-montant ${m.montant >= 0 ? 'pos' : 'neg'}">${m.montant >= 0 ? '+' : ''}${U.fmtEUR(m.montant)}</span>
        <span class="mvt-info">${U.fmtDateTime(m.date)}${m.note ? ` — <em>${U.esc(m.note)}</em>` : ''}</span>
      </li>`).join('') + `</ul>` : `<p class="muted">Aucun mouvement pour l'instant.</p>`;

    return `<section class="view">
      <a class="back-link" href="#${archivee ? '/archives' : '/'}">← ${archivee ? 'Archives' : 'Mes cagnottes'}</a>
      <div class="detail-head">
        <div class="detail-img">${imgHTML(c.image, 'lg')}</div>
        <div class="detail-title">
          <h1>${U.esc(c.nom)} ${archivee ? '<span class="badge-archive">🏆 Validée</span>' : ''}</h1>
          <div class="detail-amounts">
            <span class="big-amount">${U.fmtEUR(c.montantActuel)}</span>
            <span class="muted">/ ${U.fmtEUR(c.objectif)} · ${Math.round(p)}%</span>
          </div>
        </div>
        ${archivee ? '' : `<button class="icon-btn" data-action="edit-cagnotte" data-id="${c.id}" title="Modifier">✏️</button>`}
      </div>
      ${progressHTML(c)}
      ${valideHTML}
      ${estimHTML}

      <label class="label" for="cagnotte-desc">Description</label>
      ${archivee
        ? `<p class="desc-ro">${U.esc(c.description) || '<span class="muted">Aucune description.</span>'}</p>`
        : `<textarea id="cagnotte-desc" data-id="${c.id}" placeholder="Pourquoi cette récompense ? Décris-la ici…">${U.esc(c.description)}</textarea>`}

      ${formsHTML}

      <div class="panel">
        <h2>Progression</h2>
        ${rangeSelectorHTML(key)}
        <canvas class="chart" id="chart-cagnotte"></canvas>
      </div>

      <div class="panel">
        <h2>Mouvements</h2>
        ${mvtsHTML}
      </div>

      <div class="panel meta">
        <p class="muted">Créée le ${U.fmtDate(c.dateCreation)}${archivee ? ` · validée le ${U.fmtDate(c.dateArchivage)} (${U.fmtDuree(c.dateCreation, c.dateArchivage)})` : ''} · palier : ${U.fmtEUR(c.palier)}</p>
        ${archivee ? `<button class="btn secondary" data-action="reactiver-cagnotte" data-id="${c.id}">♻️ Réactiver</button>` : ''}
        <button class="btn danger" data-action="delete-cagnotte" data-id="${c.id}">🗑 Supprimer la cagnotte</button>
      </div>
    </section>`;
  }

  /* ---------- Écran 3 : Statistiques ---------- */

  function viewStats() {
    const s = Store.stats();
    const nd = `<span class="muted">Pas encore assez de données</span>`;

    const tiles = [
      ['💶', 'Moyenne cagnottée / jour', s.moyenneJour != null ? U.fmtEUR(s.moyenneJour) : nd],
      ['⏱', 'Temps moyen de clôture', s.tempsMoyenJours != null ? `${s.tempsMoyenJours} ${U.plural(s.tempsMoyenJours, 'jour')}` : nd],
      ['🧮', 'Cagnottes créées', s.nbCreees],
      ['🏆', 'Archivées / en cours', `${s.nbArchivees} / ${s.nbEnCours}`],
      ['💰', 'Réparti dans les cagnottes', U.fmtEUR(s.totalEnCours)],
      ['🎉', 'Total récompensé', s.nbArchivees ? U.fmtEUR(s.totalRecompense) : nd],
      ['⚡', 'Plus rapide à compléter', s.plusRapide
        ? `${U.esc(s.plusRapide.c.nom)} <span class="muted">(${s.plusRapide.jours} ${U.plural(s.plusRapide.jours, 'jour')})</span>` : nd],
      ['📅', 'Jour le plus généreux', s.meilleurJour
        ? `${s.meilleurJour.jour} <span class="muted">(${U.fmtEUR(s.meilleurJour.montant)} au total)</span>` : nd],
    ];

    return `<section class="view">
      <h1>Statistiques</h1>
      <div class="stat-grid">
        ${tiles.map(([emo, label, val]) => `
          <div class="stat-tile">
            <div class="stat-emoji">${emo}</div>
            <div class="stat-value">${val}</div>
            <div class="stat-label">${label}</div>
          </div>`).join('')}
      </div>
      <div class="panel">
        <h2>Évolution du total cagnotté</h2>
        ${rangeSelectorHTML('stats')}
        <canvas class="chart" id="chart-stats"></canvas>
      </div>
    </section>`;
  }

  /* ---------- Écran 4 : Historique / Archives ---------- */

  function viewArchives() {
    const list = Store.cagnottesArchivees();
    if (!list.length) {
      return `<section class="view"><h1>Archives</h1>
        <div class="empty-state"><div class="empty-emoji">🏆</div>
        <h2>Rien ici pour l'instant</h2>
        <p>Les cagnottes validées apparaîtront ici, comme des trophées.</p></div></section>`;
    }
    return `<section class="view">
      <h1>Archives</h1>
      <div id="archive-list">
        ${list.map(c => `
          <article class="card archive-card" data-id="${c.id}" data-action="open-cagnotte">
            <div class="card-img">${imgHTML(c.image)}</div>
            <div class="card-body">
              <h3>${U.esc(c.nom)}</h3>
              <div class="card-amounts"><strong>${U.fmtEUR(c.objectif)}</strong> <span class="muted">atteints</span></div>
              <p class="muted small">Du ${U.fmtDate(c.dateCreation)} au ${U.fmtDate(c.dateArchivage)} · ${U.fmtDuree(c.dateCreation, c.dateArchivage)}</p>
            </div>
            <button class="btn secondary small" data-action="reactiver-cagnotte" data-id="${c.id}">♻️ Réactiver</button>
          </article>`).join('')}
      </div>
    </section>`;
  }

  /* ---------- Écran 5 : Bourse ---------- */

  function libelleMouvementBourse(m) {
    if (m.type === 'manuel') return '✍️ Mouvement manuel';
    const c = Store.getCagnotte(m.cagnotteId);
    const nom = c ? c.nom : 'cagnotte supprimée';
    return m.montant < 0 ? `📤 Transfert vers « ${nom} »` : `📥 Retour de « ${nom} »`;
  }

  function viewBourse() {
    const b = Store.state.bourse;
    const mouvements = [...b.mouvements].sort((a, x) => new Date(x.date) - new Date(a.date));

    return `<section class="view">
      <h1>La Bourse</h1>
      <div class="bourse-solde ${b.solde < 0 ? 'negatif' : ''}">
        <span class="bourse-icon">👛</span>
        <span class="bourse-montant">${U.fmtEUR(b.solde)}</span>
        <span class="muted">solde disponible</span>
      </div>

      <div class="panel">
        <h2>Mouvement manuel</h2>
        <p class="hint">Ajoute (+) ou retire (−) de l'argent directement, sans passer par une cagnotte.</p>
        <form id="form-bourse" class="montant-libre">
          <div class="field-row">
            <input type="text" name="montant" inputmode="decimal" placeholder="Montant (€)" required>
            <input type="text" name="note" placeholder="Note (optionnel)" maxlength="120">
          </div>
          <div class="field-row">
            <button type="submit" class="btn primary" data-sens="plus">+ Alimenter</button>
            <button type="submit" class="btn secondary" data-sens="minus">− Débiter</button>
          </div>
        </form>
      </div>

      <div class="panel">
        <h2>Évolution du solde</h2>
        ${rangeSelectorHTML('bourse')}
        <canvas class="chart" id="chart-bourse"></canvas>
      </div>

      <div class="panel">
        <h2>Historique des mouvements</h2>
        ${mouvements.length ? `<ul class="mvt-list">` + mouvements.map(m => `
          <li class="mvt">
            <span class="mvt-montant ${m.montant >= 0 ? 'pos' : 'neg'}">${m.montant >= 0 ? '+' : ''}${U.fmtEUR(m.montant)}</span>
            <span class="mvt-info">${libelleMouvementBourse(m)}<br>
              <span class="muted small">${U.fmtDateTime(m.date)}${m.note ? ` — <em>${U.esc(m.note)}</em>` : ''}</span></span>
          </li>`).join('') + `</ul>` : `<p class="muted">Aucun mouvement pour l'instant.</p>`}
      </div>
    </section>`;
  }

  /* ---------- Écran 6 : Réglages ---------- */

  function viewReglages() {
    const nb = Store.state.cagnottes.length;
    let taille = '';
    try {
      const octets = (localStorage.getItem('cagnottes_app_state_v1') || '').length * 2;
      taille = (octets / 1024).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' Ko';
    } catch { taille = '?'; }

    return `<section class="view">
      <h1>Réglages</h1>
      <div class="panel">
        <h2>💾 Sauvegarde</h2>
        <p class="hint">Le fichier JSON contient tout : cagnottes, mouvements, historiques et l'état complet de la Bourse.</p>
        <button class="btn primary" data-action="export-data">⬇️ Exporter mes données</button>
        <button class="btn secondary" data-action="import-data">⬆️ Importer mes données</button>
        <input type="file" id="import-file" accept=".json,application/json" hidden>
      </div>
      <div class="panel">
        <h2>ℹ️ À propos</h2>
        <p class="muted">Cagnottes v1 · ${nb} ${U.plural(nb, 'cagnotte')} · ${taille} utilisés · données 100 % locales (localStorage)</p>
        <button class="btn danger" data-action="reset-data">🗑 Effacer toutes les données</button>
      </div>
    </section>`;
  }

  /* ---------- Modales ---------- */

  function openModal(html, { onClose = null } = {}) {
    const root = document.getElementById('modal-root');
    root.innerHTML = `<div class="modal-overlay" data-action="modal-close">
      <div class="modal" role="dialog">
        <button class="modal-x" data-action="modal-close">✕</button>
        ${html}
      </div>
    </div>`;
    root._onClose = onClose;
    return root.querySelector('.modal');
  }

  function closeModal() {
    const root = document.getElementById('modal-root');
    if (root._onClose) root._onClose();
    root._onClose = null;
    root.innerHTML = '';
  }

  function confirmDialog(message, { danger = false, okLabel = 'Oui' } = {}) {
    return new Promise(resolve => {
      const modal = openModal(`
        <h2 class="modal-title">Es-tu sûr ?</h2>
        <p>${message}</p>
        <div class="field-row">
          <button class="btn ${danger ? 'danger' : 'primary'}" id="confirm-ok">${okLabel}</button>
          <button class="btn secondary" id="confirm-cancel">Annuler</button>
        </div>`, { onClose: () => resolve(false) });
      modal.querySelector('#confirm-ok').addEventListener('click', () => {
        document.getElementById('modal-root')._onClose = null;
        closeModal();
        resolve(true);
      });
      modal.querySelector('#confirm-cancel').addEventListener('click', () => closeModal());
    });
  }

  /* ---------- Formulaire de cagnotte (création / édition) ---------- */

  function cagnotteFormModal(existing = null) {
    const img = existing ? existing.image : { type: 'emoji', value: '🎁' };
    const modal = openModal(`
      <h2 class="modal-title">${existing ? 'Modifier la cagnotte' : 'Nouvelle cagnotte'}</h2>
      <form id="form-cagnotte" data-id="${existing ? existing.id : ''}">
        <label class="label">Nom</label>
        <input type="text" name="nom" required maxlength="60" placeholder="Ex : Nouvelle manette" value="${existing ? U.esc(existing.nom) : ''}">

        <label class="label">Image</label>
        <div class="img-tabs">
          <button type="button" class="tab${img.type === 'emoji' ? ' active' : ''}" data-imgtab="emoji">Emoji</button>
          <button type="button" class="tab${img.type === 'url' ? ' active' : ''}" data-imgtab="url">URL</button>
          <button type="button" class="tab${img.type === 'upload' ? ' active' : ''}" data-imgtab="upload">Photo</button>
        </div>
        <div class="img-pane" data-imgpane="emoji" ${img.type !== 'emoji' ? 'hidden' : ''}>
          <div class="emoji-grid">
            ${EMOJIS.map(e => `<button type="button" class="emoji-pick${img.type === 'emoji' && img.value === e ? ' selected' : ''}" data-emoji="${e}">${e}</button>`).join('')}
          </div>
        </div>
        <div class="img-pane" data-imgpane="url" ${img.type !== 'url' ? 'hidden' : ''}>
          <input type="url" name="imageUrl" placeholder="https://…" value="${img.type === 'url' ? U.esc(img.value) : ''}">
        </div>
        <div class="img-pane" data-imgpane="upload" ${img.type !== 'upload' ? 'hidden' : ''}>
          <input type="file" name="imageFile" accept="image/*">
          <p class="hint">L'image sera réduite et stockée localement.</p>
        </div>
        <div class="img-preview" id="img-preview">${imgHTML(img, 'lg')}</div>

        <div class="field-row">
          <div class="field">
            <label class="label">Objectif (€)</label>
            <input type="text" name="objectif" inputmode="decimal" required placeholder="60" value="${existing ? String(existing.objectif).replace('.', ',') : ''}">
          </div>
          <div class="field">
            <label class="label">Palier +/− (€)</label>
            <input type="text" name="palier" inputmode="decimal" required placeholder="0,50" value="${existing ? String(existing.palier).replace('.', ',') : ''}">
          </div>
        </div>

        <label class="label">Description <span class="muted">(optionnel)</span></label>
        <textarea name="description" placeholder="Pourquoi cette récompense ?">${existing ? U.esc(existing.description) : ''}</textarea>

        <button type="submit" class="btn primary wide">${existing ? 'Enregistrer' : 'Créer la cagnotte'}</button>
      </form>`);

    /* État de l'image en cours de sélection */
    modal._image = { ...img };

    /* Onglets */
    modal.querySelectorAll('[data-imgtab]').forEach(tab => tab.addEventListener('click', () => {
      modal.querySelectorAll('[data-imgtab]').forEach(t => t.classList.toggle('active', t === tab));
      modal.querySelectorAll('[data-imgpane]').forEach(p => p.hidden = p.dataset.imgpane !== tab.dataset.imgtab);
    }));

    /* Choix d'emoji */
    modal.querySelectorAll('.emoji-pick').forEach(btn => btn.addEventListener('click', () => {
      modal.querySelectorAll('.emoji-pick').forEach(b => b.classList.toggle('selected', b === btn));
      modal._image = { type: 'emoji', value: btn.dataset.emoji };
      updatePreview();
    }));

    /* URL */
    modal.querySelector('[name=imageUrl]').addEventListener('change', e => {
      if (e.target.value.trim()) {
        modal._image = { type: 'url', value: e.target.value.trim() };
        updatePreview();
      }
    });

    /* Upload → redimensionnement en base64 */
    modal.querySelector('[name=imageFile]').addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        const imgEl = new Image();
        imgEl.onload = () => {
          const MAX = 400;
          const scale = Math.min(1, MAX / Math.max(imgEl.width, imgEl.height));
          const cv = document.createElement('canvas');
          cv.width = Math.round(imgEl.width * scale);
          cv.height = Math.round(imgEl.height * scale);
          cv.getContext('2d').drawImage(imgEl, 0, 0, cv.width, cv.height);
          modal._image = { type: 'upload', value: cv.toDataURL('image/jpeg', 0.8) };
          updatePreview();
        };
        imgEl.src = reader.result;
      };
      reader.readAsDataURL(file);
    });

    function updatePreview() {
      modal.querySelector('#img-preview').innerHTML = imgHTML(modal._image, 'lg');
    }
  }

  /* ---------- Popup de félicitations ---------- */

  function celebrate(c) {
    const confetti = Array.from({ length: 60 }, () => {
      const left = Math.random() * 100;
      const delay = Math.random() * 1.2;
      const dur = 2 + Math.random() * 2;
      const colors = ['#E8A33D', '#177E5B', '#E05252', '#4A90D9', '#C77DBB', '#F0C948'];
      const color = colors[Math.floor(Math.random() * colors.length)];
      const size = 6 + Math.random() * 7;
      const rot = Math.random() * 360;
      return `<span class="confetti" style="left:${left}%;background:${color};width:${size}px;height:${size * 0.6}px;
        animation-delay:${delay}s;animation-duration:${dur}s;transform:rotate(${rot}deg)"></span>`;
    }).join('');

    openModal(`
      <div class="celebrate">
        <div class="confetti-box">${confetti}</div>
        <div class="celebrate-img pop">${imgHTML(c.image, 'lg')}</div>
        <h2>Bravo ! 🎉</h2>
        <p><strong>${U.esc(c.nom)}</strong> est complétée :<br>
          <span class="celebrate-montant">${U.fmtEUR(c.objectif)}</span> économisés pour te récompenser.</p>
        <p class="muted">La cagnotte rejoint tes archives — offre-toi ta récompense, tu l'as méritée !</p>
        <button class="btn primary wide" data-action="modal-close-home">Youpi !</button>
      </div>`);
  }

  /* ---------- Drag & drop (réordonnancement des cartes) ---------- */

  function initDragAndDrop() {
    const list = document.getElementById('cagnotte-list');
    if (!list) return;

    list.querySelectorAll('.drag-handle').forEach(handle => {
      handle.addEventListener('pointerdown', ev => {
        ev.preventDefault();
        const card = handle.closest('.cagnotte-card');
        const startY = ev.clientY;
        let dragging = false;
        let ghost = null;

        const move = e => {
          if (!dragging && Math.abs(e.clientY - startY) > 6) {
            dragging = true;
            const r = card.getBoundingClientRect();
            ghost = card.cloneNode(true);
            ghost.className = 'cagnotte-card drag-ghost';
            ghost.style.width = r.width + 'px';
            document.body.appendChild(ghost);
            card.classList.add('drag-placeholder');
          }
          if (!dragging) return;
          ghost.style.top = (e.clientY - 30) + 'px';
          ghost.style.left = card.getBoundingClientRect().left + 'px';
          /* Insère le placeholder avant/après la carte survolée */
          const over = document.elementsFromPoint(e.clientX, e.clientY)
            .find(el => el.classList && el.classList.contains('cagnotte-card') && el !== ghost && el !== card);
          if (over) {
            const r = over.getBoundingClientRect();
            if (e.clientY < r.top + r.height / 2) list.insertBefore(card, over);
            else list.insertBefore(card, over.nextSibling);
          }
        };

        const up = () => {
          document.removeEventListener('pointermove', move);
          document.removeEventListener('pointerup', up);
          document.removeEventListener('pointercancel', up);
          if (ghost) ghost.remove();
          card.classList.remove('drag-placeholder');
          if (dragging) {
            const ids = [...list.querySelectorAll('.cagnotte-card')].map(el => el.dataset.id);
            Store.reordonner(ids);
          }
        };

        document.addEventListener('pointermove', move);
        document.addEventListener('pointerup', up);
        document.addEventListener('pointercancel', up);
      });
    });
  }

  /* ---------- Dessin des graphiques après rendu ---------- */

  function afterRender(route) {
    if (route.name === 'cagnotte') {
      const c = Store.getCagnotte(route.id);
      const cv = document.getElementById('chart-cagnotte');
      if (c && cv) Charts.draw(cv, serieFor('cagnotte:' + route.id, c.historiqueJournalier), { goal: c.objectif });
    }
    if (route.name === 'bourse') {
      const cv = document.getElementById('chart-bourse');
      if (cv) Charts.draw(cv, serieFor('bourse', Store.state.bourse.historiqueJournalier));
    }
    if (route.name === 'stats') {
      const cv = document.getElementById('chart-stats');
      if (cv) Charts.draw(cv, serieFor('stats', Store.stats().histoGlobal));
    }
    if (route.name === 'home') initDragAndDrop();
  }

  return {
    viewHome, viewCagnotte, viewStats, viewArchives, viewBourse, viewReglages,
    openModal, closeModal, confirmDialog, cagnotteFormModal, celebrate,
    afterRender, ranges
  };
})();
