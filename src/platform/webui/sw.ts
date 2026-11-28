/**
 * The service worker: `sw.js`, registered by the page only when the operator turns notifications on.
 *
 * It does three things and nothing else — shows a push as a notification, keeps the topic the push
 * is about in the page's transcript cache, and opens (or focuses) the page on the topic when the
 * notification is tapped. In particular it has NO `fetch` handler and caches no part of the page.
 * The web UI README's rule against a service worker was about exactly that: a worker that caches
 * the app shell serves last week's page after an upgrade, with no error to say so. This one cannot,
 * because every request the page makes still goes to the network as if it did not exist. What it
 * writes is a transcript, into the store the page itself writes them to, in the record format and
 * under the write rule both take from `cache-script.ts` — so a push that lands after the page kept a
 * newer copy of the topic cannot put an older one over it.
 *
 * Plain ES5-ish JavaScript like the page's own script, kept as a string so it ships inside the
 * package with no build step and no file to locate at runtime.
 */
import { CACHE_CORE } from './cache-script.js';

export const SERVICE_WORKER = `'use strict';
${CACHE_CORE}

/**
 * Fetch the topic a push is about into the cache, so the page that opens it — from the
 * notification, or the person coming back to it — paints the reply at once and resumes the stream
 * from there (page.ts enter).
 *
 * This is the case the page cannot cover by itself: it fetches only while it is on screen, and on a
 * phone the page is in the background, or not running at all, exactly when a push arrives. A page
 * that IS on screen fetches what needs the person itself (prefetchOne), so then this does nothing.
 * Every failure is silent: the notification is the point of a push, and a topic not kept is a topic
 * opened the way it always was.
 */
function keepTopic(topic){
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) if (list[i].visibilityState === 'visible') return null;
    if (!self.indexedDB) return null;
    return fetch('api/topic?t=' + encodeURIComponent(topic), { credentials: 'same-origin', cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || d.topic !== topic || !d.epoch) return null;
        var rec = cacheRecord(topic, snapshotMsgs(d), {
          epoch: d.epoch,
          last: d.last,
          stale: Boolean(d.stale),
          hasMore: Boolean(d.hasMore),
          oldestSeq: d.oldestSeq,
        });
        return cacheOpen(self.indexedDB).then(function (o) {
          if (!o.db) return null;
          return new Promise(function (res) {
            var tx, put;
            try { tx = o.db.transaction(STORE, 'readwrite'); } catch (x) { o.db.close(); return res(null); }
            put = cachePut(tx.objectStore(STORE), rec);
            tx.oncomplete = function () { o.db.close(); res(put.stood ? null : rec); };
            tx.onabort = tx.onerror = function () { o.db.close(); res(null); };
          });
        });
      })
      .then(function (rec) {
        if (!rec) return;
        // What the store now holds of the topic, for a page that is open but hidden: it would
        // otherwise go on putting up the older copy it has in memory, or fetch this one again.
        var kept = { topic: rec.topic, epoch: rec.epoch, last: rec.last || '' };
        for (var j = 0; j < list.length; j++) list[j].postMessage({ cached: kept });
      });
  }).catch(function () {});
}

// A push, as webpush.ts sends it: {topic, title, body}, encrypted to this browser.
self.addEventListener('push', function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = {}; }
  var title = typeof d.title === 'string' && d.title ? d.title : 'fleetherd';
  var body = typeof d.body === 'string' ? d.body : '';
  var topic = typeof d.topic === 'string' ? d.topic : '';
  // One notification per topic (the tag): a second update replaces the first instead of stacking.
  // Shown first and at once — a push that shows nothing is one a browser holds against the site.
  var shown = self.registration.showNotification(title, {
    body: body,
    tag: topic || 'fleetherd',
    renotify: true,
    icon: 'icon.png',
    data: { topic: topic }
  });
  e.waitUntil(Promise.all([shown, topic ? keepTopic(topic) : null]));
});

// Tapped: bring an open page to the topic, or open one there.
self.addEventListener('notificationclick', function (e) {
  e.notification.close();
  var topic = e.notification.data && e.notification.data.topic;
  var url = self.registration.scope + (topic ? '?t=' + encodeURIComponent(topic) : '');
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (list) {
    for (var i = 0; i < list.length; i++) {
      var c = list[i];
      if (c.url.indexOf(self.registration.scope) === 0 && 'focus' in c) {
        if (topic) c.postMessage({ goto: topic });
        return c.focus();
      }
    }
    return self.clients.openWindow(url);
  }));
});
`;
