'use strict';

/* Service worker : pré-cache de tous les assets pour un fonctionnement 100 % hors-ligne.
   Incrémenter CACHE_VERSION à chaque mise à jour de l'app pour invalider l'ancien cache. */
const CACHE_VERSION = 'cagnottes-v6-logos';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/utils.js',
  './js/charts.js',
  './js/views.js',
  './js/app.js',
  './js/main.js',
  './js/store.js',
  './js/eclats-local.js',
  './js/eclats-cagnottes.js',
  './js/eclats-registre.js',
  './js/bourse.js',
  './js/bascule-euros.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_VERSION).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

/*
 * Navigation (la page elle-même) : RÉSEAU D'ABORD. La servir depuis le cache
 * figeait l'app sur une version périmée — c'est elle qui référence les scripts,
 * donc une coquille périmée entraîne toute l'app avec elle. Hors ligne, on
 * retombe sur la copie mise en cache.
 */
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;

  /* Seule la page de l'application est gérée ici : toute autre page part
     directement au réseau, pour ne jamais être servie depuis un cache abîmé. */
  const chemin = new URL(e.request.url).pathname;
  const estPageApp = chemin.endsWith('/') || chemin.endsWith('/index.html');
  if (e.request.mode === 'navigate' && !estPageApp) return;

  if (e.request.mode === 'navigate') {
    e.respondWith(
      fetch(e.request)
        .then(resp => {
          /* NE JAMAIS mettre en cache une réponse invalide : pendant une
             reconstruction de GitHub Pages, le site répond brièvement 404.
             Sans ce garde-fou, cette 404 devient la page de l'app, servie
             indéfiniment. En cas d'erreur, on préfère la copie en cache. */
          if (!resp || !resp.ok) {
            return caches.match('./index.html').then(r => (r && r.ok ? r : resp));
          }
          const clone = resp.clone();
          caches.open(CACHE_VERSION).then(c => c.put('./index.html', clone));
          return resp;
        })
        /* Hors ligne : une copie invalide (404 héritée) n'est jamais servie. */
        .catch(() => caches.match('./index.html')
          .then(r => (r && r.ok ? r : caches.match('./')))
          .then(r => (r && r.ok ? r : Response.error())))
    );
    return;
  }

  /* Reste des ressources : cache d'abord, avec mise en cache au vol des
     ressources same-origin (images de cagnottes chargées par URL). */
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(resp => {
        const url = new URL(e.request.url);
        if (resp.ok && url.origin === location.origin) {
          const clone = resp.clone();
          caches.open(CACHE_VERSION).then(c => c.put(e.request, clone));
        }
        return resp;
      }).catch(() => {
        /* Hors-ligne et absent du cache : renvoie la coquille de l'app pour les navigations */
        if (e.request.mode === 'navigate') return caches.match('./index.html');
        return new Response('', { status: 503, statusText: 'Hors-ligne' });
      });
    })
  );
});
