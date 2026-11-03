/*
 * Ingle workflow demo: a browser simulation of one day.
 *
 * The orchestrator below mirrors the Kotlin one in askp-dev/kioku-android (core/orchestrator):
 * deterministic rules, confidence gate, per-tier cooldowns, an interruption budget that refills
 * through the day and shrinks in the evening, and priority tiers. It adds one rule the brief asks
 * for: a missed care-critical prompt is asked again in identical words, then the caregiver is told.
 *
 * Every input is scripted. Nothing here touches a camera, a microphone or real data.
 */
(function () {
  "use strict";

  /* ---------------- Truth store: what the caregiver set up ---------------- */
  var STORE = {
    patient: { name: "Margaret Hale", preferredName: "Maggie" },
    people: [
      { id: "maya", name: "Maya", relationship: "granddaughter", consented: true, enrolledBy: "David, in the caregiver app" },
      { id: "david", name: "David", relationship: "son", consented: true, enrolledBy: "David, in the caregiver app" }
    ],
    routines: [
      { id: "meds-am", time: "08:00", windowMinutes: 60, message: "It's time for your morning tablet. It's the small white one, in the blue box by the kettle." },
      { id: "lunch", time: "12:30", windowMinutes: 45, message: "Lunch is at twelve thirty." },
      { id: "meds-pm", time: "19:10", windowMinutes: 45, message: "It's time for your evening tablet. It's in the blue box, by the kettle." }
    ],
    followUp: { maxAsks: 2, sameWords: true, thenNotify: "caregiver" },
    notes: [
      { id: "david-call", at: "09:10", text: "David called this morning. He sends his love.", source: "caregiver app" }
    ],
    places: {
      home: { safeLine: "You're at home, Maggie. It's night-time, so let's stay in tonight." }
    },
    caregiver: { name: "David", relationship: "son", notify: "caregiver app" }
  };
  function person(id) { return STORE.people.filter(function (p) { return p.id === id; })[0]; }
  function routine(id) { return STORE.routines.filter(function (r) { return r.id === id; })[0]; }

  /* Recorded Wren lines (from the landing page), keyed by exact wording. Anything else uses the browser's voice. */
  var CLIPS = {
    "That's Maya, your granddaughter.": "maya",
    "It's time for your morning tablet. It's the small white one, in the blue box by the kettle.": "medicine",
    "It's time for your evening tablet. It's in the blue box, by the kettle.": "evening",
    "Lunch is at twelve thirty.": "lunch"
  };

  /* ---------------- Orchestrator config (same defaults as the Kotlin demo) ---------------- */
  var CONFIG = {
    confidenceGate: 0.85,
    cooldownMin: { SAFETY: 2, CARE_CRITICAL: 15, SOCIAL: 20, ENRICHMENT: 240 },
    baseCost: { SAFETY: 0, CARE_CRITICAL: 2, SOCIAL: 1.5, ENRICHMENT: 2.5 },
    conversationMultiplier: 2,
    recentPromptMultiplier: 1.5,
    recentPromptWindowMin: 3,
    budget: { capacity: 10, refillPerHour: 6, eveningStart: 16 * 60, eveningEnd: 23 * 60, eveningFactor: 0.6 },
    dayStart: 7 * 60
  };
  var TIER_NAME = { SAFETY: "Safety", CARE_CRITICAL: "Care-critical", SOCIAL: "Social", ENRICHMENT: "Enrichment" };

  var RULES = [
    { id: "safety", name: "Safety first" },
    { id: "circle", name: "Enrolled circle only" },
    { id: "gate", name: "Confidence gate" },
    { id: "follow", name: "Already asked?" },
    { id: "cooldown", name: "Cooldown" },
    { id: "moment", name: "Right moment" },
    { id: "budget", name: "Interruption budget" }
  ];

  function hm(min) { var h = Math.floor(min / 60), m = min % 60; return (h < 10 ? "0" : "") + h + ":" + (m < 10 ? "0" : "") + m; }
  function fmt(n) { return (Math.round(n * 10) / 10).toFixed(1); }

  function createEngine() {
    var s = { points: CONFIG.budget.capacity, lastRefill: CONFIG.dayStart, lastSpoken: {}, lastPromptAt: null, asks: {}, askTimes: {}, confirmed: {} };

    function capacityAt(min) {
      var b = CONFIG.budget;
      return min >= b.eveningStart && min < b.eveningEnd ? b.capacity * b.eveningFactor : b.capacity;
    }
    function refill(now) {
      var hours = Math.max(0, now - s.lastRefill) / 60;
      if (hours > 0) s.lastRefill = now;
      s.points = Math.min(capacityAt(now), s.points + hours * CONFIG.budget.refillPerHour);
    }
    function spoke(key, now) { s.lastSpoken[key] = now; s.lastPromptAt = now; }

    function decide(c, m) {
      var now = m.now;
      refill(now);
      var checks = RULES.map(function (r) { return { id: r.id, name: r.name, status: "skip", why: "Not reached." }; });
      function mark(id, status, why) { checks.forEach(function (k) { if (k.id === id) { k.status = status; k.why = why; } }); }
      function out(action, reason, extra) {
        var d = { action: action, reason: reason, checks: checks, cost: 0, say: null, alert: null, wouldSay: null };
        for (var k in extra || {}) d[k] = extra[k];
        refill(now);
        d.budgetAfter = s.points; d.capacity = capacityAt(now);
        return d;
      }

      // 1. Safety bypasses everything.
      if (c.tier === "SAFETY") {
        mark("safety", "stop", "Safety tier. Skips the other rules and the budget.");
        spoke(c.key, now);
        return out("ESCALATE", "safety tier bypasses the budget; caregiver alerted, calm line to Maggie", { say: c.say, alert: c.alert });
      }
      mark("safety", "pass", "Not a safety event.");

      // 2. Strangers are never named.
      if (c.kind === "UNKNOWN_FACE") {
        mark("circle", "stop", "No match in the enrolled circle. The frame is dropped on the phone and nothing is kept.");
        return out("SILENT", "not in the enrolled circle; face discarded");
      }
      mark("circle", "pass", c.kind === "FACE" ? "Matched someone the caregiver enrolled with consent." : "No face involved.");

      // 3. Confidence gate.
      if (c.kind === "FACE") {
        if (c.confidence < CONFIG.confidenceGate) {
          mark("gate", "stop", "Match score " + c.confidence.toFixed(2) + " is below the " + CONFIG.confidenceGate.toFixed(2) + " gate. Better quiet than wrong.");
          return out("SILENT", "confidence " + c.confidence.toFixed(2) + " below gate " + CONFIG.confidenceGate.toFixed(2), { wouldSay: c.say });
        }
        mark("gate", "pass", "Match score " + c.confidence.toFixed(2) + " clears the " + CONFIG.confidenceGate.toFixed(2) + " gate.");
      } else mark("gate", "pass", "Not a face match.");

      // 4. Follow-ups on care-critical prompts: same words again, then outward to the caregiver.
      if (c.kind === "FOLLOWUP") {
        var asked = s.asks[c.key] || 0, times = (s.askTimes[c.key] || []).map(hm).join(" and ");
        if (s.confirmed[c.key]) {
          mark("follow", "stop", "The pill box shows it was taken. Nothing to say.");
          return out("SILENT", "routine confirmed by pill box sensor; nothing to say");
        }
        if (asked >= STORE.followUp.maxAsks) {
          mark("follow", "stop", "Asked " + asked + " times in the same words (" + times + ") and still not taken. Tell the caregiver; nothing louder for Maggie.");
          return out("ESCALATE", "asked " + asked + "x with identical wording, not confirmed; caregiver notified, patient not re-prompted", {
            alert: "Maggie hasn't taken her " + c.what + " yet. Wren asked at " + times + ", in the same calm words."
          });
        }
        mark("follow", "pass", asked ? "Asked once at " + times + ". Ask again, in exactly the same words." : "Not asked yet.");
      } else mark("follow", "pass", "Not a follow-up.");

      // 5. Cooldown.
      var cd = CONFIG.cooldownMin[c.tier] || 0, last = s.lastSpoken[c.key];
      if (last != null && now - last < cd) {
        mark("cooldown", "stop", "Said " + (now - last) + " min ago. " + TIER_NAME[c.tier] + " cooldown is " + cd + " min.");
        return out("SILENT", "cooldown: said " + (now - last) + "m ago, cooldown " + cd + "m", { wouldSay: c.say });
      }
      mark("cooldown", "pass", last == null ? "Not said yet today." : "Last said " + (now - last) + " min ago; cooldown is " + cd + " min.");

      // 6. Enrichment only in a quiet moment.
      if (c.tier === "ENRICHMENT" && !m.quiet) {
        mark("moment", "stop", "Nice-to-know news waits for a quiet moment. Maggie is mid-conversation.");
        return out("SILENT", "enrichment waits for a quiet moment; held", { wouldSay: c.say });
      }
      mark("moment", "pass", c.tier === "ENRICHMENT" ? "Quiet moment, nobody talking." : "No timing limit for this tier.");

      // 7. Budget.
      var cost = CONFIG.baseCost[c.tier], why = [];
      if (m.talking) { cost *= CONFIG.conversationMultiplier; why.push("interrupting a conversation ×" + CONFIG.conversationMultiplier); }
      if (s.lastPromptAt != null && now - s.lastPromptAt < CONFIG.recentPromptWindowMin) { cost *= CONFIG.recentPromptMultiplier; why.push("just spoke ×" + CONFIG.recentPromptMultiplier); }
      var whyTxt = why.length ? " (" + why.join(", ") + ")" : "";
      var have = s.points;
      function speakNow(forced) {
        if (forced) s.points = Math.max(0, s.points - cost); else s.points -= cost;
        spoke(c.key, now);
        if (c.kind === "ROUTINE" || c.kind === "FOLLOWUP") {
          s.asks[c.key] = (s.asks[c.key] || 0) + 1;
          (s.askTimes[c.key] = s.askTimes[c.key] || []).push(now);
        }
      }
      if (have >= cost) {
        mark("budget", "pass", "Costs " + fmt(cost) + whyTxt + ". " + fmt(have) + " of " + fmt(capacityAt(now)) + " points available.");
        speakNow(false);
        return out("SPEAK", "within budget, cost " + fmt(cost) + whyTxt, { say: c.say, cost: cost });
      }
      if (c.tier === "CARE_CRITICAL") {
        if (c.deadline != null && now >= c.deadline) {
          mark("budget", "pass", "Over budget, but the window is closing. Care-critical prompts must be delivered.");
          speakNow(true);
          return out("SPEAK", "care-critical window closing; delivered over budget" + whyTxt, { say: c.say, cost: cost });
        }
        mark("budget", "stop", "Needs " + fmt(cost) + whyTxt + ", only " + fmt(have) + " left. Waits inside its window.");
        return out("WAIT", "over budget (need " + fmt(cost) + "); waiting within window", { wouldSay: c.say });
      }
      mark("budget", "stop", "Needs " + fmt(cost) + whyTxt + ", only " + fmt(have) + " left. Silence costs little here.");
      return out("SILENT", "over budget (need " + fmt(cost) + ", have " + fmt(have) + "); silence costs little", { wouldSay: c.say });
    }

    return { decide: decide, state: s, capacityAt: capacityAt };
  }

  /* ---------------- The scripted day ---------------- */
  function faceLine(p) { return "That's " + p.name + ", your " + p.relationship + "."; }
  function at(h, m) { return h * 60 + m; }

  var STEPS = [
    {
      id: "am-meds", min: at(8, 0), label: "Morning tablet due",
      title: "08:00. Time for the morning tablet.",
      blurb: "A routine the caregiver entered comes due. Care-critical prompts must be delivered; only their timing can flex.",
      knobs: ["talking"], defaults: { talking: false },
      build: function (k) {
        var r = routine("meds-am");
        return {
          scene: { kind: "clock", time: "08:00" },
          caption: "No camera needed: a timer on the phone fires.",
          perception: [["Trigger", "Routine timer: meds-am at 08:00"], ["Camera", "Not used"]],
          truth: { snippet: r, use: ["message", "windowMinutes"] },
          candidate: { key: r.id, kind: "ROUTINE", tier: "CARE_CRITICAL", confidence: 1, say: r.message, deadline: at(8, 0) + r.windowMinutes },
          moment: { talking: k.talking, quiet: !k.talking, activity: "Sitting in the kitchen" },
          template: "Routine message, word for word from the truth store."
        };
      }
    },
    {
      id: "am-check", min: at(8, 15), label: "Was it taken?",
      title: "08:15. The pill box was opened.",
      blurb: "Fifteen minutes later Ingle checks the pill box sensor. If the tablet was taken, there's nothing to say.",
      knobs: ["taken"], defaults: { taken: true },
      build: function (k) {
        var r = routine("meds-am");
        return {
          scene: { kind: "pillbox", taken: k.taken, time: "08:07" },
          caption: k.taken ? "Simulated pill box sensor: lid opened at 08:07." : "Simulated pill box sensor: lid not opened.",
          perception: [["Trigger", "Follow-up check for meds-am"], ["Pill box", k.taken ? "Opened at 08:07" : "Not opened since 08:00"]],
          truth: { snippet: STORE.followUp, use: ["maxAsks", "sameWords"] },
          candidate: { key: r.id, kind: "FOLLOWUP", tier: "CARE_CRITICAL", confidence: 1, say: r.message, what: "morning tablet", deadline: at(8, 0) + r.windowMinutes, confirm: k.taken },
          moment: { talking: false, quiet: true, activity: "Making tea" },
          template: "If asked again: the same routine message, unchanged."
        };
      }
    },
    {
      id: "maya", min: at(8, 20), label: "Maya arrives",
      title: "08:20. Someone walks into the kitchen.",
      blurb: "The glasses capture a frame when a voice is nearby. The phone matches the face against the small enrolled circle, on the device.",
      knobs: ["confidence", "talking"], defaults: { confidence: 0.94, talking: false },
      build: function (k) {
        var p = person("maya");
        return {
          scene: { kind: "face", label: "Maya", conf: k.confidence, tone: "known" },
          caption: "Simulated frame from the glasses, captured because someone said hello.",
          perception: [["Trigger", "Voice nearby, frame captured"], ["Face match", "Maya, score " + k.confidence.toFixed(2) + " (on the phone)"]],
          truth: { snippet: p, use: ["name", "relationship", "consented"] },
          candidate: { key: "face:maya", kind: "FACE", tier: "SOCIAL", confidence: k.confidence, say: faceLine(p) },
          moment: { talking: k.talking, quiet: !k.talking, activity: "Sitting at the table" },
          template: "Fixed template “That's {name}, your {relationship}.” filled from the truth store. One fact, warm and short, never a quiz."
        };
      }
    },
    {
      id: "maya-again", min: at(8, 31), label: "Maya again, too soon",
      title: "08:31. Maya comes back from the hallway.",
      blurb: "Same face, eleven minutes later. Naming her again would be noise.",
      knobs: ["confidence"], defaults: { confidence: 0.95 },
      build: function (k) {
        var p = person("maya");
        return {
          scene: { kind: "face", label: "Maya", conf: k.confidence, tone: "known", shift: 70 },
          caption: "Simulated frame: Maya is back in view.",
          perception: [["Trigger", "Voice nearby, frame captured"], ["Face match", "Maya, score " + k.confidence.toFixed(2)]],
          truth: { snippet: p, use: ["name", "relationship"] },
          candidate: { key: "face:maya", kind: "FACE", tier: "SOCIAL", confidence: k.confidence, say: faceLine(p) },
          moment: { talking: true, quiet: false, activity: "Chatting with Maya" },
          template: "Same template, but the rules decide first."
        };
      }
    },
    {
      id: "stranger", min: at(10, 20), label: "A stranger passes",
      title: "10:20. A stranger passes at the shop.",
      blurb: "Bystanders never consented, so they are never enrolled. Their frames are thrown away on the phone.",
      knobs: [], defaults: {},
      build: function () {
        return {
          scene: { kind: "face", label: "No match", conf: 0.31, tone: "stranger" },
          caption: "Simulated frame. In the product this frame is deleted on the phone, never stored or uploaded.",
          perception: [["Trigger", "Voice nearby, frame captured"], ["Face match", "No enrolled match (best score 0.31)"], ["Frame", "Discarded on the phone"]],
          truth: null,
          candidate: { key: "face:unknown", kind: "UNKNOWN_FACE", tier: "SOCIAL", confidence: 0.31, say: null },
          moment: { talking: false, quiet: false, activity: "Walking through the shop" },
          template: "Nothing to phrase. Strangers are never described."
        };
      }
    },
    {
      id: "news", min: at(15, 30), label: "News from David",
      title: "15:30. David's morning call, worth mentioning.",
      blurb: "David logged a call in the caregiver app. Nice to hear, but not urgent, so it only comes up in a quiet moment.",
      knobs: ["talking"], defaults: { talking: true },
      build: function (k) {
        var n = STORE.notes[0];
        return {
          scene: { kind: "phone" },
          caption: "A note from the caregiver app arrives at the phone hub.",
          perception: [["Trigger", "New note from the caregiver app"], ["Camera", "Not used"]],
          truth: { snippet: n, use: ["text", "source"] },
          candidate: { key: n.id, kind: "NOTE", tier: "ENRICHMENT", confidence: 1, say: n.text },
          moment: { talking: k.talking, quiet: !k.talking, activity: k.talking ? "Chatting with a friend" : "Resting in the armchair" },
          template: "The caregiver's note, as written."
        };
      }
    },
    {
      id: "unsure", min: at(17, 40), label: "Not sure who that is",
      title: "17:40. Someone at the door, face half-turned.",
      blurb: "The best match is David, but the score is low. A wrong name is worse than no name.",
      knobs: ["confidence"], defaults: { confidence: 0.62 },
      build: function (k) {
        var p = person("david");
        return {
          scene: { kind: "face", label: "David?", conf: k.confidence, tone: "unsure" },
          caption: "Simulated frame: poor light, face turned away.",
          perception: [["Trigger", "Doorbell, frame captured"], ["Face match", "Maybe David, score " + k.confidence.toFixed(2)]],
          truth: { snippet: p, use: ["name", "relationship"] },
          candidate: { key: "face:david", kind: "FACE", tier: "SOCIAL", confidence: k.confidence, say: faceLine(p) },
          moment: { talking: false, quiet: true, activity: "Standing in the hall" },
          template: "“That's {name}, your {relationship}.” Only if the gate is cleared."
        };
      }
    },
    {
      id: "pm-meds", min: at(19, 10), label: "Evening tablet due",
      title: "19:10. Time for the evening tablet.",
      blurb: "It's evening, so the interruption budget is smaller: late-day confusion makes every prompt cost more attention.",
      knobs: ["talking"], defaults: { talking: false },
      build: function (k) {
        var r = routine("meds-pm");
        return {
          scene: { kind: "clock", time: "19:10" },
          caption: "A timer on the phone fires.",
          perception: [["Trigger", "Routine timer: meds-pm at 19:10"], ["Camera", "Not used"]],
          truth: { snippet: r, use: ["message", "windowMinutes"] },
          candidate: { key: r.id, kind: "ROUTINE", tier: "CARE_CRITICAL", confidence: 1, say: r.message, deadline: at(19, 10) + r.windowMinutes },
          moment: { talking: k.talking, quiet: !k.talking, activity: "Sitting in the lounge" },
          template: "Routine message, word for word from the truth store."
        };
      }
    },
    {
      id: "david", min: at(19, 12), label: "David, mid-conversation",
      title: "19:12. David arrives while Maggie is talking.",
      blurb: "A confident match, but Wren just spoke, Maggie is mid-sentence and the evening budget is low. Naming a face can wait.",
      knobs: ["confidence", "talking"], defaults: { confidence: 0.93, talking: true },
      build: function (k) {
        var p = person("david");
        return {
          scene: { kind: "face", label: "David", conf: k.confidence, tone: "known" },
          caption: "Simulated frame: David walks in.",
          perception: [["Trigger", "Voice nearby, frame captured"], ["Face match", "David, score " + k.confidence.toFixed(2)]],
          truth: { snippet: p, use: ["name", "relationship"] },
          candidate: { key: "face:david", kind: "FACE", tier: "SOCIAL", confidence: k.confidence, say: faceLine(p) },
          moment: { talking: k.talking, quiet: !k.talking, activity: k.talking ? "Talking with a neighbour" : "Sitting in the lounge" },
          template: "Fixed template “That's {name}, your {relationship}.”"
        };
      }
    },
    {
      id: "pm-check-1", min: at(19, 25), label: "Not taken: ask again",
      title: "19:25. The evening tablet is still in the box.",
      blurb: "Asked once, not taken. Wren asks again in exactly the same words. It never sounds more urgent.",
      knobs: ["taken"], defaults: { taken: false },
      build: function (k) {
        var r = routine("meds-pm");
        return {
          scene: { kind: "pillbox", taken: k.taken, time: "19:21" },
          caption: k.taken ? "Simulated pill box sensor: lid opened at 19:21." : "Simulated pill box sensor: lid not opened since 19:10.",
          perception: [["Trigger", "Follow-up check for meds-pm"], ["Pill box", k.taken ? "Opened at 19:21" : "Not opened since 19:10"]],
          truth: { snippet: STORE.followUp, use: ["maxAsks", "sameWords"] },
          candidate: { key: r.id, kind: "FOLLOWUP", tier: "CARE_CRITICAL", confidence: 1, say: r.message, what: "evening tablet", deadline: at(19, 10) + r.windowMinutes, confirm: k.taken },
          moment: { talking: false, quiet: true, activity: "Sitting in the lounge" },
          template: "Identical wording to 19:10. Repeats are a signal, so they never change."
        };
      }
    },
    {
      id: "pm-check-2", min: at(19, 40), label: "Still not taken: tell David",
      title: "19:40. Still not taken.",
      blurb: "Escalate outward, not louder. Maggie hears nothing new; David gets a quiet heads-up.",
      knobs: ["taken"], defaults: { taken: false },
      build: function (k) {
        var r = routine("meds-pm");
        return {
          scene: { kind: "pillbox", taken: k.taken, time: "19:33" },
          caption: k.taken ? "Simulated pill box sensor: lid opened at 19:33." : "Simulated pill box sensor: still not opened.",
          perception: [["Trigger", "Follow-up check for meds-pm"], ["Pill box", k.taken ? "Opened at 19:33" : "Not opened since 19:10"]],
          truth: { snippet: { followUp: STORE.followUp, caregiver: STORE.caregiver }, use: ["maxAsks", "thenNotify", "name", "notify"] },
          candidate: { key: r.id, kind: "FOLLOWUP", tier: "CARE_CRITICAL", confidence: 1, say: r.message, what: "evening tablet", deadline: at(19, 10) + r.windowMinutes, confirm: k.taken },
          moment: { talking: false, quiet: true, activity: "Watching television" },
          template: "Nothing new for Maggie. A short factual note for the caregiver."
        };
      }
    },
    {
      id: "door", min: at(21, 40), label: "Front door after dark",
      title: "21:40. The front door opens after dark.",
      blurb: "Safety comes first and skips the budget. Wren gives one calm line, and David is told at once.",
      knobs: [], defaults: {},
      build: function () {
        var h = STORE.places.home;
        return {
          scene: { kind: "door" },
          caption: "Simulated door sensor and phone location: at the front door, after dark.",
          perception: [["Trigger", "Front door opened"], ["Location", "Home, at the front door"], ["Time", "After dark"]],
          truth: { snippet: { places: STORE.places, caregiver: STORE.caregiver }, use: ["safeLine", "name", "notify"] },
          candidate: { key: "night-door", kind: "SAFETY", tier: "SAFETY", confidence: 1, say: h.safeLine, alert: "The front door opened at 21:40, after dark. Wren reassured Maggie with one calm line." },
          moment: { talking: false, quiet: true, activity: "At the front door" },
          template: "A fixed calm line from the truth store. Never an alarm in Maggie's ear."
        };
      }
    }
  ];

  /* ---------------- Simulation runner ---------------- */
  var overrides = {};
  function knobsFor(step) {
    var k = {}, o = overrides[step.id] || {};
    for (var key in step.defaults) k[key] = key in o ? o[key] : step.defaults[key];
    return k;
  }
  function simulate(upTo) {
    var eng = createEngine(), results = [];
    for (var i = 0; i <= upTo; i++) {
      var step = STEPS[i], k = knobsFor(step), b = step.build(k);
      if (b.candidate.kind === "FOLLOWUP" && b.candidate.confirm) eng.state.confirmed[b.candidate.key] = true;
      var m = { now: step.min, talking: b.moment.talking, quiet: b.moment.quiet };
      var d = eng.decide(b.candidate, m);
      results.push({ step: step, built: b, decision: d, knobs: k, evening: eng.capacityAt(step.min) < CONFIG.budget.capacity });
    }
    return results;
  }

  /* ---------------- Rendering ---------------- */
  var $ = function (id) { return document.getElementById(id); };
  var current = -1, results = [], soundOn = false;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function jsonHtml(obj, use) {
    return JSON.stringify(obj, null, 2).split("\n").map(function (line) {
      var mm = line.match(/^\s*"([^"]+)":/), e = esc(line);
      return mm && use && use.indexOf(mm[1]) >= 0 ? "<mark>" + e + "</mark>" : e;
    }).join("\n");
  }

  function sceneSvg(sc) {
    var W = 640, H = 280, g = "";
    var ink = "fill:var(--scene-ink)", line = "stroke:var(--scene-ink);fill:none;stroke-width:3";
    // a hint of a room: floor line and a window
    var room = '<line x1="0" y1="232" x2="640" y2="232" style="' + line + ';opacity:.35"/>' +
      '<rect x="470" y="44" width="110" height="120" rx="8" style="' + line + ';opacity:.3"/>' +
      '<line x1="525" y1="44" x2="525" y2="164" style="' + line + ';opacity:.3"/>';
    if (sc.kind === "face") {
      var x = 300 + (sc.shift || 0), y = 120;
      var tone = sc.tone, op = tone === "stranger" ? 0.45 : 0.8;
      var head = tone === "unsure"
        ? '<ellipse cx="' + (x + 6) + '" cy="' + y + '" rx="30" ry="40" style="' + ink + ';opacity:' + op + '"/>'
        : '<circle cx="' + x + '" cy="' + y + '" r="38" style="' + ink + ';opacity:' + op + '"/>';
      var body = '<path d="M' + (x - 92) + ' 280 C' + (x - 88) + ' 196 ' + (x - 50) + ' 172 ' + x + ' 172 C' + (x + 50) + ' 172 ' + (x + 88) + ' 196 ' + (x + 92) + ' 280 Z" style="' + ink + ';opacity:' + (op * 0.85) + '"/>';
      var bx = x - 58, by = y - 60, bw = 116, bh = 120;
      var boxStyle = tone === "known" ? "stroke:var(--moss-deep);fill:none;stroke-width:3" : "stroke:var(--scene-ink);fill:none;stroke-width:3;stroke-dasharray:8 7";
      var box = '<rect x="' + bx + '" y="' + by + '" width="' + bw + '" height="' + bh + '" rx="10" style="' + boxStyle + '"/>';
      var label = sc.label + (tone === "stranger" ? "" : " · " + sc.conf.toFixed(2));
      var lw = Math.max(110, label.length * 12 + 28);
      var lblBg = tone === "known" ? "fill:var(--moss-deep)" : "fill:var(--surface);stroke:var(--scene-ink);stroke-width:1.5";
      var lblInk = tone === "known" ? "fill:var(--on-moss-deep)" : "fill:var(--ink)";
      var tag = '<rect x="' + (x - lw / 2) + '" y="' + (by - 44) + '" width="' + lw + '" height="34" rx="17" style="' + lblBg + '"/>' +
        '<text x="' + x + '" y="' + (by - 21) + '" text-anchor="middle" style="' + lblInk + ';font:600 19px var(--font-brand)">' + esc(label) + '</text>';
      var cross = tone === "stranger" ? '<path d="M' + bx + ' ' + by + ' L' + (bx + bw) + ' ' + (by + bh) + ' M' + (bx + bw) + ' ' + by + ' L' + bx + ' ' + (by + bh) + '" style="stroke:var(--scene-ink);stroke-width:2.5;opacity:.7"/>' : "";
      g = room + body + head + box + cross + tag;
    } else if (sc.kind === "clock") {
      var parts = sc.time.split(":"), hh = +parts[0] % 12, mi = +parts[1];
      var ah = (hh + mi / 60) * 30 * Math.PI / 180, am = mi * 6 * Math.PI / 180, cx = 320, cy = 136;
      g = '<circle cx="' + cx + '" cy="' + cy + '" r="92" style="fill:var(--surface);stroke:var(--scene-ink);stroke-width:3"/>';
      for (var t = 0; t < 12; t++) { var a = t * Math.PI / 6; g += '<line x1="' + (cx + 78 * Math.sin(a)) + '" y1="' + (cy - 78 * Math.cos(a)) + '" x2="' + (cx + 86 * Math.sin(a)) + '" y2="' + (cy - 86 * Math.cos(a)) + '" style="stroke:var(--scene-ink);stroke-width:3"/>'; }
      g += '<line x1="' + cx + '" y1="' + cy + '" x2="' + (cx + 46 * Math.sin(ah)) + '" y2="' + (cy - 46 * Math.cos(ah)) + '" style="stroke:var(--ink);stroke-width:7;stroke-linecap:round"/>' +
        '<line x1="' + cx + '" y1="' + cy + '" x2="' + (cx + 70 * Math.sin(am)) + '" y2="' + (cy - 70 * Math.cos(am)) + '" style="stroke:var(--ink);stroke-width:4;stroke-linecap:round"/>' +
        '<circle cx="' + cx + '" cy="' + cy + '" r="7" style="fill:var(--moss-deep)"/>';
    } else if (sc.kind === "pillbox") {
      var open = sc.taken;
      g = room + '<rect x="214" y="150" width="212" height="74" rx="12" style="fill:var(--surface);stroke:var(--scene-ink);stroke-width:3"/>' +
        '<line x1="285" y1="150" x2="285" y2="224" style="stroke:var(--scene-ink);stroke-width:2;opacity:.5"/><line x1="355" y1="150" x2="355" y2="224" style="stroke:var(--scene-ink);stroke-width:2;opacity:.5"/>' +
        (open
          ? '<path d="M214 150 L236 86 L448 86 L426 150" style="fill:var(--sage);stroke:var(--scene-ink);stroke-width:3;opacity:.9"/>'
          : '<rect x="208" y="136" width="224" height="20" rx="8" style="fill:var(--sage);stroke:var(--scene-ink);stroke-width:3"/><circle cx="390" cy="188" r="10" style="fill:var(--ink);opacity:.75"/>') +
        '<text x="320" y="262" text-anchor="middle" style="fill:var(--ink);font:600 19px var(--font-brand)">' + (open ? "Lid opened " + sc.time : "Lid closed") + '</text>';
    } else if (sc.kind === "phone") {
      g = '<rect x="250" y="20" width="140" height="250" rx="22" style="fill:var(--surface);stroke:var(--scene-ink);stroke-width:3"/>' +
        '<rect x="266" y="70" width="108" height="64" rx="12" style="fill:var(--sand)"/>' +
        '<line x1="280" y1="92" x2="358" y2="92" style="stroke:#1b211a;stroke-width:5;stroke-linecap:round;opacity:.6"/><line x1="280" y1="112" x2="336" y2="112" style="stroke:#1b211a;stroke-width:5;stroke-linecap:round;opacity:.6"/>' +
        '<rect x="266" y="146" width="108" height="16" rx="8" style="fill:var(--wash)"/><rect x="266" y="170" width="80" height="16" rx="8" style="fill:var(--wash)"/>';
    } else if (sc.kind === "door") {
      g = '<line x1="0" y1="232" x2="640" y2="232" style="' + line + ';opacity:.35"/>' +
        '<rect x="250" y="40" width="140" height="192" rx="4" style="fill:var(--forest);opacity:.85"/>' +
        '<path d="M250 40 L320 58 L320 250 L250 232 Z" style="fill:var(--surface);stroke:var(--scene-ink);stroke-width:3"/>' +
        '<circle cx="308" cy="150" r="5" style="fill:var(--scene-ink)"/>' +
        '<path d="M356 78 a22 22 0 1 0 22 30 a17 17 0 1 1 -22 -30 Z" style="fill:var(--sand)"/>' +
        '<circle cx="345" cy="160" r="2.5" style="fill:var(--sand)"/><circle cx="372" cy="190" r="2" style="fill:var(--sand)"/>';
    }
    return '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Simulated scene" preserveAspectRatio="xMidYMid meet">' + g + "</svg>";
  }

  var ACTION_LABEL = { SPEAK: "Speak", SILENT: "Stay quiet", WAIT: "Wait", ESCALATE: "Tell caregiver" };
  function chip(a) { return '<span class="chip ' + a.toLowerCase() + '">' + ACTION_LABEL[a] + "</span>"; }

  function renderSteps() {
    $("steps").innerHTML = STEPS.map(function (s, i) {
      var r = results[i], cls = "step-btn";
      if (r && i <= current) { cls += " done out-" + r.decision.action.toLowerCase(); }
      return '<li><button type="button" class="' + cls + '" data-i="' + i + '"' + (i === current ? ' aria-current="step"' : "") + '>' +
        '<span class="t">' + hm(s.min) + '</span><span class="l">' + esc(s.label) + '</span><span class="d" aria-hidden="true"></span></button></li>';
    }).join("");
    $("progress").textContent = Math.max(0, current + 1) + " / " + STEPS.length;
    $("prev").disabled = current < 0;
    $("next").textContent = current < 0 ? "Start the day" : current >= STEPS.length - 1 ? "Start over" : "Next event";
  }

  function renderKnobs() {
    var step = STEPS[current];
    if (!step || !step.knobs.length) { $("try").hidden = true; return; }
    $("try").hidden = false;
    var k = knobsFor(step), html = "";
    step.knobs.forEach(function (name) {
      if (name === "confidence") {
        html += '<div class="knob"><label for="k-conf"><span>Face match score</span><output id="k-conf-out">' + k.confidence.toFixed(2) + '</output></label>' +
          '<input id="k-conf" type="range" min="0.40" max="0.99" step="0.01" value="' + k.confidence + '">' +
          '<p class="knob-note">The gate is ' + CONFIG.confidenceGate.toFixed(2) + '. Below it, Wren says nothing.</p></div>';
      } else {
        var label = name === "talking" ? "Someone is talking" : "Tablet taken";
        html += '<div class="knob"><button type="button" class="switch" role="switch" data-k="' + name + '" aria-checked="' + !!k[name] + '"><span class="switch-track"><span class="switch-thumb"></span></span><span>' + label + "</span></button></div>";
      }
    });
    html += '<p class="knob-note">Changes replay the day from the start, so later events react too.</p>';
    $("knobs").innerHTML = html;
    var conf = $("k-conf");
    if (conf) {
      conf.addEventListener("input", function () { $("k-conf-out").textContent = (+conf.value).toFixed(2); });
      conf.addEventListener("change", function () { setOverride("confidence", +conf.value); });
    }
    [].forEach.call($("knobs").querySelectorAll(".switch"), function (b) {
      b.addEventListener("click", function () { setOverride(b.getAttribute("data-k"), b.getAttribute("aria-checked") !== "true"); });
    });
  }

  function setOverride(key, value) {
    var id = STEPS[current].id;
    overrides[id] = overrides[id] || {};
    overrides[id][key] = value;
    show(current, { keepKnobs: key === "confidence" });
  }

  function renderBudget(r) {
    var cap = CONFIG.budget.capacity;
    if (!r) {
      $("budget-wrap").innerHTML = budgetHtml(cap, cap, cap);
      return;
    }
    $("budget-wrap").innerHTML = budgetHtml(r.decision.budgetAfter, r.decision.capacity, cap);
  }
  function budgetHtml(points, capNow, capMax) {
    return '<div class="budget-row"><span>Interruption budget</span><span>' + fmt(points) + " / " + fmt(capNow) + " points</span></div>" +
      '<div class="budget-bar" role="img" aria-label="Budget ' + fmt(points) + " of " + fmt(capNow) + '"><div class="budget-fill" style="width:' + (points / capMax * 100) + '%"></div><div class="budget-cap" style="left:calc(' + (capNow / capMax * 100) + '% - 1px)"></div></div>' +
      '<div class="budget-row"><span>Refills ' + CONFIG.budget.refillPerHour + " per hour</span><span>" + (capNow < capMax ? "Evening: smaller bucket" : "Daytime bucket") + "</span></div>";
  }

  function renderLog() {
    if (current < 0) { $("log").innerHTML = '<li class="log-empty" style="border:0;background:none;padding:0">Nothing yet. Every decision will appear here with its reason, including the times Wren stays quiet.</li>'; return; }
    var items = [];
    for (var i = current; i >= 0; i--) {
      var r = results[i], d = r.decision;
      items.push('<li class="' + (i === current ? "now" : "") + '"><div class="row"><span class="ev">' + esc(r.step.label) + '</span>' + chip(d.action) + '</div>' +
        '<div class="row"><span class="tm">' + hm(r.step.min) + " · " + TIER_NAME[r.built.candidate.tier] + '</span><span class="bd">budget ' + fmt(d.budgetAfter) + "/" + fmt(d.capacity) + "</span></div>" +
        '<p class="rs">' + esc(d.reason) + "</p></li>");
    }
    $("log").innerHTML = items.join("");
  }

  function renderPipeline() {
    if (current < 0) {
      $("pipeline").innerHTML = '<div class="empty"><p class="cap">How it works</p>' +
        '<h2 class="ui" style="font-weight:700;font-size:24px;line-height:30px">Five steps, from the glasses to the ear</h2>' +
        '<ol class="how">' +
        '<li><b>1</b><span><strong class="ui">Glasses</strong> capture a frame only on a trigger, like a voice nearby. Timers and sensors on the phone raise events too.</span></li>' +
        '<li><b>2</b><span><strong class="ui">Perception</strong> matches faces on the phone, against a small circle the caregiver enrolled with consent.</span></li>' +
        '<li><b>3</b><span><strong class="ui">Truth store</strong> holds the verified facts. Wren can phrase them, never invent them.</span></li>' +
        '<li><b>4</b><span><strong class="ui">Orchestrator</strong> runs fixed rules to decide: speak, stay quiet, wait, or tell the caregiver.</span></li>' +
        '<li><b>5</b><span><strong class="ui">Wren</strong> says one short line, or nothing. Every decision is logged.</span></li></ol>' +
        "<p>Press <strong>Start the day</strong> to step through twelve events. Use <em>Try it</em> to change an input and watch the rules respond.</p></div>";
      return;
    }
    var r = results[current], s = r.step, b = r.built, d = r.decision, c = b.candidate;
    var halted = d.checks.filter(function (k) { return k.status === "stop"; })[0];

    var html = '<div class="scene-head"><p class="cap">Event ' + (current + 1) + " of " + STEPS.length + " · " + TIER_NAME[c.tier] + ' tier</p><h2>' + esc(s.title) + "</h2><p>" + esc(s.blurb) + "</p></div>";
    html += '<ol class="pipe">';

    // 1 Glasses / trigger
    html += stage(1, "Glasses and sensors", "", '<div class="scene">' + sceneSvg(b.scene) + '</div><p class="muted" style="font-size:14px;line-height:20px">' + esc(b.caption) + "</p>");

    // 2 Perception + context
    var ctx = [["Time", hm(s.min) + (r.evening ? " (evening)" : "")], ["Moment", b.moment.activity + (b.moment.talking ? ", someone is talking" : ", nobody talking")]];
    html += stage(2, "Perception and context", "on the phone", '<dl class="facts">' + b.perception.concat(ctx).map(function (p) { return "<dt>" + esc(p[0]) + "</dt><dd>" + esc(p[1]) + "</dd>"; }).join("") + "</dl>");

    // 3 Truth store
    html += stage(3, "Truth store", "verified facts",
      b.truth ? '<pre class="json">' + jsonHtml(b.truth.snippet, b.truth.use) + "</pre>" : '<p class="skip-note">Not consulted. There is no one to look up, and nothing about this person is kept.</p>');

    // 4 Orchestrator
    var rules = '<ul class="rules">' + d.checks.map(function (k) {
      var ic = k.status === "pass" ? "✓" : k.status === "stop" ? "■" : "";
      return '<li class="rule ' + k.status + '"><span class="ic" aria-hidden="true">' + ic + '</span><span><span class="nm">' + esc(k.name) + '</span> <span class="why">' + esc(k.why) + "</span></span></li>";
    }).join("") + "</ul>";
    var verdict = '<div class="verdict">' + chip(d.action) + '<span class="muted" style="font-size:14px;line-height:20px">' + esc(halted ? "Stopped at: " + halted.name : "All rules passed") + "</span></div>";
    html += stage(4, "Orchestrator", "fixed rules, no AI", rules + verdict, !!halted);

    // 5 Wren
    var w = '<div class="wren">';
    if (d.say) {
      var clip = CLIPS[d.say];
      w += '<div class="wren-line"><span class="wren-dot" id="wren-dot"></span><p class="wren-text">“' + esc(d.say) + "”</p></div>";
      w += '<p class="wren-meta">' + esc(b.template) + (clip ? " Recorded Wren voice." : " Browser voice stands in for Wren here.") + "</p>";
    } else {
      var quiet = d.action === "ESCALATE" ? "Wren says nothing new to Maggie." : d.action === "WAIT" ? "Wren waits for a better moment." : "Wren stays quiet.";
      w += '<div class="wren-line"><span class="wren-dot quiet"></span><p class="wren-text quiet">' + quiet + (d.wouldSay ? " It would have said “" + esc(d.wouldSay) + "”" : "") + "</p></div>";
    }
    if (d.alert) w += '<div class="alert"><span class="cap">Caregiver app · to ' + esc(STORE.caregiver.name) + "</span><p>" + esc(d.alert) + "</p></div>";
    w += "</div>";
    html += stage(5, "Wren", d.say ? "speaks" : "silent", w);
    html += "</ol>";
    $("pipeline").innerHTML = html;
  }

  function stage(n, title, sub, body, halt) {
    return '<li class="stage' + (halt ? " halt" : "") + '"><span class="stage-n" aria-hidden="true">' + n + '</span><div class="card"><div class="card-head"><h3 class="card-title">' + esc(title) + "</h3>" +
      (sub ? '<span class="tag line">' + esc(sub) + "</span>" : "") + "</div>" + body + "</div></li>";
  }

  var revealTimers = [], sayTimer = 0;
  function reveal(animate, then) {
    revealTimers.forEach(clearTimeout); revealTimers = [];
    var stages = [].slice.call(document.querySelectorAll(".stage"));
    if (!animate || reduce) { then && then(); return; }
    stages.forEach(function (el) { el.classList.add("pending"); });
    stages.forEach(function (el, i) { revealTimers.push(setTimeout(function () { el.classList.remove("pending"); }, 120 + i * 260)); });
    revealTimers.push(setTimeout(function () { then && then(); }, 120 + stages.length * 260));
  }

  function show(i, opts) {
    opts = opts || {};
    stopVoice();
    current = i;
    results = i >= 0 ? simulate(i) : [];
    renderSteps();
    if (!opts.keepKnobs) renderKnobs();
    renderPipeline();
    renderLog();
    renderBudget(results[i]);
    reveal(!!opts.animate, function () {
      var d = results[i] && results[i].decision;
      if (d && d.say) speakLine(d.say);
    });
    if (opts.scroll && window.innerWidth <= 820) $("pipeline-panel").scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }

  /* ---------------- Voice ---------------- */
  var audio = null, synth = window.speechSynthesis || null, chosen = null;
  function pickVoice() {
    if (!synth) return;
    var vs = synth.getVoices().filter(function (v) { return /^en/i.test(v.lang); });
    var prefs = [/Samantha/i, /Serena/i, /Google UK English Female/i, /Female/i, /Moira/i, /Karen/i];
    for (var i = 0; i < prefs.length && !chosen; i++) chosen = vs.filter(function (v) { return prefs[i].test(v.name); })[0] || null;
    chosen = chosen || vs[0] || null;
  }
  if (synth) { pickVoice(); synth.onvoiceschanged = pickVoice; }
  function talking(on) { var dot = $("wren-dot"); if (dot) dot.classList.toggle("talking", on); }
  function stopVoice() {
    clearTimeout(sayTimer);
    if (audio) { audio.pause(); audio = null; }
    if (synth) synth.cancel();
    talking(false);
  }
  function speakLine(text) {
    if (!soundOn) return;
    var clip = CLIPS[text];
    if (clip) {
      audio = new Audio("/voice/" + clip + ".mp3");
      audio.onplaying = function () { talking(true); };
      audio.onended = audio.onerror = function () { talking(false); };
      audio.play().catch(function () { talking(false); });
    } else if (synth && window.SpeechSynthesisUtterance) {
      var u = new SpeechSynthesisUtterance(text);
      if (chosen) u.voice = chosen;
      u.rate = 0.9;
      u.onstart = function () { talking(true); };
      u.onend = u.onerror = function () { talking(false); };
      synth.speak(u);
    }
  }
  $("sound").addEventListener("click", function () {
    soundOn = !soundOn;
    this.setAttribute("aria-pressed", String(soundOn));
    this.querySelector("span").textContent = soundOn ? "Wren is on" : "Hear Wren";
    $("wave").setAttribute("opacity", soundOn ? "1" : ".35");
    if (!soundOn) stopVoice();
    else if (current >= 0 && results[current].decision.say) speakLine(results[current].decision.say);
  });

  /* ---------------- Wiring ---------------- */
  $("next").addEventListener("click", function () {
    if (current >= STEPS.length - 1) { overrides = {}; show(-1); return; }
    show(current + 1, { animate: true, scroll: true });
  });
  $("prev").addEventListener("click", function () { show(current - 1, { animate: false }); });
  $("steps").addEventListener("click", function (e) {
    var b = e.target.closest(".step-btn");
    if (b) show(+b.getAttribute("data-i"), { animate: true, scroll: true });
  });
  $("reset-knobs").addEventListener("click", function () { delete overrides[STEPS[current].id]; show(current); });
  document.addEventListener("keydown", function (e) {
    if (e.target.closest("input, textarea, [role=switch]")) return;
    if (e.key === "ArrowRight" && current < STEPS.length - 1) show(current + 1, { animate: true });
    if (e.key === "ArrowLeft" && current > -1) show(current - 1);
  });

  $("store-json").innerHTML = jsonHtml(STORE, []);
  show(-1);
})();
