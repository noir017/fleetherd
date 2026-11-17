/**
 * The browser's transcript cache — its database, its record and its rotation — as one piece of
 * script that both of its writers include: the page (`page.ts`), and the service worker (`sw.ts`),
 * which keeps the topic a push is about so the page that opens it finds it already there.
 *
 * Two writers of one IndexedDB store must agree on its name, its version, the shape of a record
 * and how many records there may be; written out twice, a change to one is a page that reads the
 * other's records wrong. So it is written once, here, and interpolated into both scripts. Plain
 * ES5-ish JavaScript like the rest of them, with nothing in it that needs a `window`: the factory
 * to open is passed in.
 *
 * One record per topic, holding the message list as a STRING rather than an object graph. The
 * byte budget is then something that can actually be measured, and nothing rests on how a
 * structured clone treats these objects.
 *
 * Sized from the live gateway's 200 kept topics, measured 2026-11-17: 21 messages in the median
 * topic, 356 in the longest; 87K characters of JSON in the median topic and 817K in the largest.
 * So a record holds a whole topic — up to the daemon's own 1000 messages — rather than the last
 * 200 it held through 3.9.0, and a whole topic is what lets a record be RESUMED from (`last`)
 * instead of only painted. The hundred topics are a few megabytes in the common case and well
 * under every browser's per-site quota at the worst.
 */
export const CACHE_CORE = `
  var DB_NAME='aa_cache', DB_VER=1, STORE='topics';
  var MAX_CACHE_TOPICS=100, MAX_CACHE_MSGS=1000, MAX_CACHE_BYTES=2*1024*1024;

  /** Open the database: resolves {db} or {error}, never rejects. */
  function cacheOpen(factory){
    return new Promise(function(res){
      var rq;
      try { rq = factory.open(DB_NAME, DB_VER); } catch(x){ return res({error:x}); }
      rq.onupgradeneeded = function(){
        var d = rq.result;
        if(d.objectStoreNames.contains(STORE)) return;
        // The at field is indexed so eviction can walk oldest-first over KEYS alone — a cursor
        // over the records would read every cached transcript into memory to delete one of them.
        d.createObjectStore(STORE, {keyPath:'topic'}).createIndex('at','at');
      };
      rq.onsuccess = function(){ res({db:rq.result}); };
      rq.onerror = function(){ res({error:rq.error}); };
      rq.onblocked = function(){ res({error:'another tab holds an older version'}); };
    });
  }

  /**
   * One topic's record: as much of msgs as fits, from the end, and what the copy is of.
   *
   * meta.epoch is the run of the daemon the copy came from and meta.lastAt the row's lastAt as of
   * it: together they say whether the copy has the topic's latest reply. meta.last is where that
   * run's stream had got to, and is kept only when nothing of that run was cut to fit — a record
   * that is the whole topic can be resumed from it, one that is not can only be painted. Messages
   * of an older run above it are history the daemon no longer has, and cutting them costs nothing.
   */
  function cacheRecord(tId, msgs, meta){
    var out = msgs.length > MAX_CACHE_MSGS ? msgs.slice(-MAX_CACHE_MSGS) : msgs;
    var json = JSON.stringify(out);
    // A quarter at a time rather than one message at a time: a topic of long answers would
    // otherwise re-serialise itself dozens of times on the way under the budget.
    while(json.length > MAX_CACHE_BYTES && out.length > 1){
      out = out.slice(Math.max(1, Math.round(out.length/4)));
      json = JSON.stringify(out);
    }
    var rec = {topic:tId, at:Date.now(), json:json};
    if(!meta || !meta.epoch) return rec;
    rec.epoch = meta.epoch;
    if(meta.lastAt) rec.lastAt = meta.lastAt;
    if(meta.stale) rec.stale = true;
    var whole = true;
    for(var i=0;i<msgs.length-out.length;i++) if(msgs[i]._g === meta.epoch){ whole = false; break; }
    if(whole && meta.last) rec.last = meta.last;
    return rec;
  }

  /** Drop the least recently written topics. all throws away everything except keep. */
  function cacheEvict(store, keep, all){
    var count = store.count();
    count.onsuccess = function(){
      var over = all ? count.result : count.result - MAX_CACHE_TOPICS;
      if(over <= 0) return;
      var cur = store.index('at').openKeyCursor();
      cur.onsuccess = function(){
        var at = cur.result;
        if(!at || over <= 0) return;
        if(at.primaryKey !== keep){ store.delete(at.primaryKey); over--; }
        at.continue();
      };
    };
  }

  /**
   * The messages of an api/topic answer, as the page holds them: the /setting page is never a
   * transcript row, and every message says which run it belongs to — the rule reconcile applies,
   * where a message a topic kept from an earlier run carries its own g.
   */
  function snapshotMsgs(d){
    var out=[], list=(d && d.messages) || [];
    for(var j=0;j<list.length;j++){
      var m=list[j];
      if(!m || !m.id || m.settings || m.wasSettings) continue;
      m._g = m.g || d.epoch;
      out.push(m);
    }
    return out;
  }
`;
