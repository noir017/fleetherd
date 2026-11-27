/**
 * The browser's transcript cache — its database, its record, its rotation, and the one rule for
 * which of two copies of a topic is newer — as one piece of script that both of its writers
 * include: the page's client script (`client/main.ts`), and the service worker (`sw.ts`),
 * which keeps the topic a push is about so the page that opens it finds it already there.
 *
 * Two writers of one IndexedDB store must agree on its name, its version, the shape of a record,
 * how many records there may be and which copy wins; written out twice, a change to one is a page
 * that reads the other's records wrong, or lets an older copy over a newer one. So it is written
 * once, here, and put into both scripts: interpolated into sw.ts's string, and filled into the
 * client script's `__FH_CACHE_CORE__` marker by the asset build (`scripts/webui-client.mjs`) — text
 * rather than an import, because sw.ts is a string. Plain ES5-ish JavaScript like the rest of them,
 * with nothing in it that needs a `window`: the factory to open is passed in.
 *
 * One record per topic, holding the message list as a STRING rather than an object graph. The
 * byte budget is then something that can actually be measured, and nothing rests on how a
 * structured clone treats these objects.
 *
 * Sized from the live gateway's 200 kept topics, measured 2026-11-17: 21 messages in the median
 * topic, 356 in the longest; 87K characters of JSON in the median topic and 817K in the largest.
 * So a record holds a whole topic — up to the daemon's own 1000 messages — and a whole topic is
 * what lets a record be RESUMED from (`last`) instead of only painted. The hundred topics are a few
 * megabytes in the common case and well under every browser's per-site quota at the worst.
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
   * Where a copy stands in its topic's history: the id of the last event it reflects
   * (<topic>.<run>.<seq>, the stream's own ids, and what the topic list's row and api/topic call
   * last), as {run, seq}. The run is the daemon's start time in base 36 — the same number as the
   * epoch a sync carries — so a later run is a later copy whatever the seq says. A copy with no id
   * (cut to fit, so nothing can be resumed from it) stands before every event of its own run and
   * after everything of an earlier one; a copy of nothing, before everything.
   */
  function copyPos(last, epoch){
    var p = typeof last === 'string' ? last.split('.') : [];
    var run = parseInt(p[1], 36), seq = Number(p[2]);
    if(p.length === 3 && run >= 0 && seq >= 0) return {run:run, seq:seq};
    return {run:Number(epoch) || 0, seq:-1};
  }

  /** Whether copy a (its last id, and its epoch for a copy without one) is newer than copy b. */
  function newer(a, b, aEpoch, bEpoch){
    var x = copyPos(a, aEpoch), y = copyPos(b, bEpoch);
    return x.run !== y.run ? x.run > y.run : x.seq > y.seq;
  }

  /**
   * One topic's record: as much of msgs as fits, from the end, and what the copy is of.
   *
   * meta.epoch is the run of the daemon the copy came from. meta.last is where that run's stream
   * had got to, and is kept only when nothing of that run was cut to fit — a record that is the
   * whole topic can be resumed from it, one that is not can only be painted. Messages of an older
   * run above it are history the daemon no longer has, and cutting them costs nothing.
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
    if(meta.stale) rec.stale = true;
    var whole = true;
    for(var i=0;i<msgs.length-out.length;i++) if(msgs[i]._g === meta.epoch){ whole = false; break; }
    if(whole && meta.last) {
      rec.last = meta.last;
      if(meta.hasMore) rec.hasMore = true;
      if(meta.oldestSeq) rec.oldestSeq = meta.oldestSeq;
    }
    return rec;
  }

  /**
   * Write rec, unless the store already holds a newer copy of its topic. The old record is read in
   * the same readwrite transaction as the put, so of two writers racing — the page's own copy on the
   * way out of a topic, a fetch that left before it, another tab, the service worker — the one that
   * lands last cannot be the older. A copy as new as the stored one is written: it is the same
   * moment of the topic, and a page rewrites its copy to drop what has since moved to aa_unsent.
   *
   * Returns {stood}: once the transaction completes, the record that was kept instead of rec, or
   * null when rec was written.
   */
  function cachePut(store, rec){
    var out = {stood:null};
    var rq = store.get(rec.topic);
    rq.onsuccess = function(){
      var old = rq.result;
      if(old && newer(old.last, rec.last, old.epoch, rec.epoch)){ out.stood = old; return; }
      store.put(rec);
      cacheEvict(store, rec.topic, false);
    };
    return out;
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
