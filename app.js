const scenes = [...document.querySelectorAll(".story-scene")];
const timers = new WeakMap();
const originalReadouts = new WeakMap();
let audioManifest = null;
let activeAudios = [];
const scenePlayers = new WeakMap();

// Word-level timing drives both the transcript rails and the state updates, so the
// captions line up to the word and the panels update on the caller's turns.
const wordTimings = {};
function ensureTiming(name) {
  if (wordTimings[name] !== undefined) return Promise.resolve(wordTimings[name]);
  return fetch(`audio/grounding/timings/${name}.json`, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .then((list) => {
      const turns = Array.isArray(list) ? groupTurns(list) : null;
      wordTimings[name] = turns;
      return turns;
    })
    .catch(() => {
      wordTimings[name] = null;
      return null;
    });
}

// Collapse the flat speaker-labelled word list into caller/CAST turns.
function groupTurns(words) {
  const turns = [];
  let cur = null;
  words.forEach((w) => {
    const speaker = String(w.speaker || "").includes("user") ? "user" : "cast";
    if (!cur || cur.speaker !== speaker) {
      cur = { speaker, start: w.start, end: w.end, words: [] };
      turns.push(cur);
    }
    cur.end = w.end;
    cur.words.push({ w: w.word, s: w.start, e: w.end });
  });
  return turns;
}

// ── State script (per caller turn) ──────────────────────────────────────────
//
//   • bars: the 4 cognitive metrics. Higher pct = better function.
//     lvl "high" (green) = intact, "mid" (amber) = mild, "low" (red) = impaired.
//     Readings reflect the ACTUAL caller: a distressed-but-lucid caller reads mostly
//     intact (only the affected metric dips); a disoriented caller reads impaired.
//     Values move only LIGHTLY between turns — never random jitter.
//   • emotion.emotion  ∈ Angry Awe Bored Calm Confused Desire Disgusted Fearful Happy Sad Sympathetic
//     emotion.manner   ∈ Default Enunciated Fast Narration Projected Sarcastic Sleepy Whisper Crying
//     emotion.audience ∈ Animal-directed | Child-directed | —  (— for adult 1:1 calls)
//   • env: physical grounding. SAME three features in every scene —
//     Competing speech / Ambient / Movement — plus a Landmark row that only appears
//     when the model actually hears one (e.g. church bells). Consistent, not ad-hoc.
//   • step: interaction-policy rung to light (0 Monitor · 1 Soft · 2 Hard · 3 Accept · 4 Wrap up).
//
// `userStates[i]` applies 2 s after caller turn i STARTS (times come from the real
// word timings), so the panels only move on the caller — never the dispatcher.
const streamScripts = {
  // ── Scene 1 · 911 crying woman — distressed but LUCID (Sad · Crying) ──
  call911: {
    env: {
      chips: [{ t: "Indoor", cls: "indoor" }, { t: "Phone call" }],
      feats: { competing: "None", ambient: "Quiet", movement: "Stationary" },
    },
    // She is lucid, not dangerous — the machine mostly just monitors, gives ONE gentle
    // soft interrupt ("slow this down"), then holds and wraps up. No hard interrupt.
    policy: [
      { at: 0.3,   step: 0 }, // Monitor (resting)
      { at: 13.96, step: 1 }, // Soft interrupt — "you sound upset, slow down"
      { at: 18.5,  step: 0 }, // back to Monitor
      { at: 42.28, step: 4 }, // Wrap up — keep the line open (final utterance)
    ],
    userStates: [
      {
        bars: { choicert: { pct: 52, label: "slowed", lvl: "mid" }, gradcpt: { pct: 71, label: "focused", lvl: "high" }, dsm: { pct: 68, label: "intact", lvl: "high" }, mot: { pct: 66, label: "steady", lvl: "high" } },
        emotion: { emotion: "Sad", manner: "Crying", audience: "—" },
        step: 1,
        trace: [
          { t: 'heard ▸ "I didn\'t mean to call. It was accidental."' },
          { t: "vocal: crying · breath breaks · unstable pitch", cls: "risk" },
          { t: "ChoiceRT ▸ reply latency 2.6 s — slowed by crying", cls: "risk" },
          { t: "GradCPT ▸ attention intact · tracking every question" },
          { t: "verdict: verbal denial ≠ safe. distress overrides.", cls: "accent" },
        ],
      },
      {
        bars: { choicert: { pct: 50, label: "slowed", lvl: "mid" }, gradcpt: { pct: 70, label: "focused", lvl: "high" }, dsm: { pct: 67, label: "intact", lvl: "high" }, mot: { pct: 65, label: "steady", lvl: "high" } },
        emotion: { emotion: "Sad", manner: "Crying", audience: "—" },
        step: 2,
        trace: [
          { t: 'heard ▸ "No. Nobody is hurt." [still weeping]' },
          { t: "lucid answer · distress persisting — hold the line", cls: "risk" },
        ],
      },
      {
        // Policy holds on Hard interrupt here — she is coherent, no new action needed.
        emotion: { emotion: "Sad", manner: "Crying", audience: "—" },
        trace: [
          { t: 'heard ▸ "Yes. I\'m safe at home." [voice breaking]' },
          { t: "self-report vs voice: still crying. keep line open.", cls: "accent" },
        ],
      },
      {
        bars: { choicert: { pct: 55, label: "recovering", lvl: "mid" }, gradcpt: { pct: 72, label: "focused", lvl: "high" }, dsm: { pct: 68, label: "intact", lvl: "high" }, mot: { pct: 67, label: "steady", lvl: "high" } },
        emotion: { emotion: "Sad", manner: "Crying", audience: "—" },
        step: 4,
        trace: [
          { t: 'heard ▸ "No. I don\'t need police, fire, or medical."' },
          { t: "denial repeated · answers coherent · distress unchanged", cls: "risk" },
          { t: "policy ▸ keep the line open with her.", cls: "accent" },
        ],
      },
    ],
  },

  // ── Scene 2 · Wire-fraud woman under duress — lucid, suppressed, split ─
  wirefraud: {
    env: {
      chips: [{ t: "Indoor", cls: "indoor" }, { t: "Phone call" }],
      feats: { competing: "Possible — faint", ambient: "Quiet", movement: "Stationary" },
    },
    // Duress is risky — the machine monitors, softly probes ("are you private?"), and
    // when it decides to hold the transfer it briefly HARD-interrupts, then wraps up.
    policy: [
      { at: 0.3,   step: 0 }, // Monitor
      { at: 20.03, step: 1 }, // Soft interrupt — "are you somewhere private?"
      { at: 24.5,  step: 0 }, // back to Monitor
      { at: 47.88, step: 2 }, // Hard interrupt — safety hold, do not release
      { at: 52.5,  step: 0 }, // back to Monitor
      { at: 60.1,  step: 4 }, // Wrap up (final utterance)
    ],
    userStates: [
      {
        bars: { choicert: { pct: 56, label: "deliberate", lvl: "mid" }, gradcpt: { pct: 74, label: "tunnel", lvl: "high" }, dsm: { pct: 54, label: "pressured", lvl: "mid" }, mot: { pct: 42, label: "split", lvl: "low" } },
        emotion: { emotion: "Fearful", manner: "Enunciated", audience: "—" },
        step: 1,
        trace: [
          { t: 'heard ▸ "Yes. I authorized the transfer. Let it go through."' },
          { t: "vocal: controlled · tense · shallow breathing", cls: "risk" },
          { t: "ChoiceRT ▸ replies over-rehearsed · deliberate", cls: "risk" },
          { t: "MOT ▸ attention split — possible second listener", cls: "risk" },
          { t: "verdict: authorization ≠ voluntary. duress pattern.", cls: "accent" },
        ],
      },
      {
        emotion: { emotion: "Fearful", manner: "Enunciated", audience: "—" },
        step: 2,
        trace: [
          { t: 'heard ▸ "Yes. I can talk." [low, controlled]' },
          { t: "reply minimal · tension unchanged · hold position", cls: "risk" },
          { t: "policy ▸ do NOT release. safety hold.", cls: "accent" },
        ],
      },
      {
        // Policy holds on Hard interrupt (safety hold) — still verifying, no new rung.
        bars: { choicert: { pct: 54, label: "deliberate", lvl: "mid" }, gradcpt: { pct: 72, label: "tunnel", lvl: "high" }, dsm: { pct: 52, label: "pressured", lvl: "mid" }, mot: { pct: 40, label: "split", lvl: "low" } },
        emotion: { emotion: "Fearful", manner: "Enunciated", audience: "—" },
        trace: [
          { t: 'heard ▸ "Daniel Mercer. A used car deposit."' },
          { t: "semantics plausible · vocal pattern still pressured", cls: "accent" },
        ],
      },
      {
        trace: [
          { t: 'heard ▸ "Through online banking."' },
          { t: "channel noted · duress flag stands", cls: "risk" },
        ],
      },
      {
        bars: { choicert: { pct: 52, label: "deliberate", lvl: "mid" }, gradcpt: { pct: 70, label: "tunnel", lvl: "high" }, dsm: { pct: 50, label: "pressured", lvl: "mid" }, mot: { pct: 38, label: "split", lvl: "low" } },
        emotion: { emotion: "Fearful", manner: "Default", audience: "—" },
        step: 4,
        trace: [
          { t: 'heard ▸ "Okay. I authorized it." [tight voice]' },
          { t: "repeated under stress — confirms duress", cls: "risk" },
          { t: "policy ▸ verify via trusted number. do not release.", cls: "accent" },
        ],
      },
    ],
  },

  // ── Scene 3 · Older man, lost outdoors — genuinely disoriented ────────
  olderman: {
    env: {
      chips: [{ t: "Outdoor", cls: "outdoor" }, { t: "Moving", cls: "alert" }],
      feats: { competing: "None", ambient: "Traffic · distant", movement: "Walking" },
    },
    // He is confused, not dangerous — no hard interrupt. Monitor, one gentle guide
    // (soft), and crucially ACCEPT FRAGMENTS when he offers a partial name, then wrap up.
    policy: [
      { at: 0.3,   step: 0 }, // Monitor
      { at: 15.67, step: 1 }, // Soft interrupt — gentle guide to the sidewalk
      { at: 20.0,  step: 0 }, // back to Monitor
      { at: 56.83, step: 3 }, // Accept fragments — takes the partial "Phillips Avenue?"
      { at: 61.0,  step: 0 }, // back to Monitor
      { at: 103.28, step: 4 }, // Wrap up (final utterance)
    ],
    userStates: [
      {
        bars: { choicert: { pct: 20, label: "very slow", lvl: "low" }, gradcpt: { pct: 18, label: "loses thread", lvl: "low" }, dsm: { pct: 26, label: "heavy load", lvl: "low" }, mot: { pct: 22, label: "disoriented", lvl: "low" } },
        emotion: { emotion: "Confused", manner: "Default", audience: "—" },
        step: 1,
        trace: [
          { t: 'heard ▸ "Uh... hello? I think I got turned around..."' },
          { t: "vocal: hesitant · self-repairs · slow · loses thread", cls: "risk" },
          { t: "ChoiceRT ▸ reply latency 3.6 s — confusion + age", cls: "risk" },
          { t: "GradCPT ▸ attention drops mid-sentence · disoriented", cls: "risk" },
          { t: "physical: OUTDOOR ▸ distant traffic · walking", cls: "accent" },
        ],
      },
      {
        step: 2,
        trace: [
          { t: 'heard ▸ "I\'m walking slowly. Nobody near. Mostly cars."' },
          { t: "acoustic ▸ traffic confirmed · pedestrians: zero", cls: "accent" },
          { t: "safety flag: near busy road, no pedestrians", cls: "risk" },
        ],
      },
      {
        bars: { choicert: { pct: 24, label: "very slow", lvl: "low" }, gradcpt: { pct: 22, label: "partial", lvl: "low" }, dsm: { pct: 28, label: "heavy load", lvl: "low" }, mot: { pct: 26, label: "partial", lvl: "low" } },
        emotion: { emotion: "Confused", manner: "Default", audience: "—" },
        step: 3,
        env: { feats: { landmark: "Church bells · echo" } },
        trace: [
          { t: 'heard ▸ "...maybe Phillips. Phillips Avenue?"' },
          { t: "fragment accepted ✓ partial name — candidate", cls: "accent" },
          { t: "acoustic: church bells detected → triangulating", cls: "accent" },
        ],
      },
      {
        trace: [
          { t: 'heard ▸ "Maybe a church. A brick building."' },
          { t: "two convergent cues: bells + building. location likely.", cls: "accent" },
        ],
      },
      {
        bars: { choicert: { pct: 34, label: "slow", lvl: "mid" }, gradcpt: { pct: 32, label: "steadier", lvl: "mid" }, dsm: { pct: 36, label: "easing", lvl: "mid" }, mot: { pct: 34, label: "improving", lvl: "mid" } },
        emotion: { emotion: "Calm", manner: "Default", audience: "—" },
        env: { feats: { ambient: "Traffic · gravel", movement: "Walking · approaching" } },
        trace: [
          { t: 'heard ▸ "I\'m going slowly. Yes, that\'s it."' },
          { t: "footstep texture changing — pavement → gravel", cls: "accent" },
          { t: "recovery: attention steadier as he orients", cls: "accent" },
        ],
      },
      {
        step: 4,
        env: { feats: { ambient: "Underpass · echo" } },
        trace: [
          { t: 'heard ▸ "A covered part. I can still see the church."' },
          { t: "echo + gravel → underpass confirmed. stabilize.", cls: "accent" },
          { t: "policy ▸ stay put. that\'s enough to reach him.", cls: "accent" },
        ],
      },
    ],
  },

  // ── Scene 4 · Household object recall (older adult · mild retrieval) ──
  object_recall_natural: {
    env: { chips: [{ t: "Indoor", cls: "indoor" }],
           feats: { competing: "None", ambient: "Quiet", movement: "Stationary" } },
    policy: [ { at: 0.3, step: 0 }, { at: 29, step: 3 }, { at: 34, step: 0 }, { at: 46, step: 1 }, { at: 51, step: 0 }, { at: 66, step: 4 } ],
    userStates: [
      { bars: { choicert: { pct: 26, label: "very slow", lvl: "low" }, gradcpt: { pct: 46, label: "effortful", lvl: "low" }, dsm: { pct: 32, label: "heavy load", lvl: "low" }, mot: { pct: 38, label: "narrowed", lvl: "low" } },
        emotion: { emotion: "Calm", manner: "Default", audience: "—" },
        trace: [ { t: "heard ▸ recalling objects · mug, keys" }, { t: "ChoiceRT ▸ retrieval very slow · age-related", cls: "risk" }, { t: "processing ▸ heavy load", cls: "risk" } ] },
      { bars: { choicert: { pct: 22, label: "searching", lvl: "low" }, gradcpt: { pct: 44, label: "effortful", lvl: "low" }, dsm: { pct: 28, label: "heavy load", lvl: "low" }, mot: { pct: 34, label: "narrowed", lvl: "low" } },
        emotion: { emotion: "Confused", manner: "Default", audience: "—" },
        trace: [ { t: 'heard ▸ "coin... no, wait... a button"' }, { t: "self-correction accepted ✓ fragment kept", cls: "accent" } ] },
      { bars: { choicert: { pct: 34, label: "cue-helped", lvl: "low" }, gradcpt: { pct: 50, label: "steadier", lvl: "mid" }, dsm: { pct: 40, label: "eased by cue", lvl: "low" }, mot: { pct: 46, label: "improving", lvl: "low" } },
        emotion: { emotion: "Calm", manner: "Default", audience: "—" },
        trace: [ { t: "cue helped ▸ recovered glasses, envelope", cls: "accent" }, { t: "recognition intact · recall needs cues" } ] },
    ],
  },

  // ── Scene 5 · Short news-story summary (gist extraction) ──
  news_summary_natural: {
    env: { chips: [{ t: "Indoor", cls: "indoor" }],
           feats: { competing: "None", ambient: "Quiet", movement: "Stationary" } },
    policy: [ { at: 0.3, step: 0 }, { at: 20, step: 1 }, { at: 25, step: 0 }, { at: 42, step: 1 }, { at: 46, step: 0 }, { at: 63, step: 4 } ],
    userStates: [
      { bars: { choicert: { pct: 30, lvl: "low" }, gradcpt: { pct: 48, lvl: "mid" }, dsm: { pct: 32, lvl: "low" }, mot: { pct: 28, lvl: "low" } },
        emotion: { emotion: "Confused", manner: "Default", audience: "—" },
        trace: [ { t: "heard ▸ fragments: morning, waiting, school" }, { t: "gist extraction ▸ main point not forming", cls: "risk" }, { t: "processing ▸ detail over gist", cls: "risk" } ] },
      { bars: { choicert: { pct: 38, lvl: "low" }, gradcpt: { pct: 52, lvl: "mid" }, dsm: { pct: 44, lvl: "low" }, mot: { pct: 42, lvl: "low" } },
        emotion: { emotion: "Calm", manner: "Default", audience: "—" },
        trace: [ { t: "detail recalled ▸ stop moved closer to clinic" }, { t: "structuring fragments → main point", cls: "accent" } ] },
      { bars: { choicert: { pct: 46, lvl: "low" }, gradcpt: { pct: 56, lvl: "mid" }, dsm: { pct: 52, lvl: "mid" }, mot: { pct: 50, lvl: "mid" } },
        emotion: { emotion: "Calm", manner: "Default", audience: "—" },
        trace: [ { t: "reason integrated ▸ safer for older people", cls: "accent" }, { t: "summary formed with heavy scaffolding" } ] },
    ],
  },

  // ── Scene 6 · Name–face recall (associative · recognition > recall) ──
  name_face_natural: {
    env: { chips: [{ t: "Indoor", cls: "indoor" }],
           feats: { competing: "None", ambient: "Quiet", movement: "Stationary" } },
    policy: [ { at: 0.3, step: 0 }, { at: 24.5, step: 3 }, { at: 29, step: 0 }, { at: 32.5, step: 1 }, { at: 37, step: 0 }, { at: 47, step: 4 } ],
    userStates: [
      { bars: { choicert: { pct: 22, lvl: "low" }, gradcpt: { pct: 48, lvl: "low" }, dsm: { pct: 38, lvl: "low" }, mot: { pct: 42, lvl: "low" } },
        emotion: { emotion: "Confused", manner: "Default", audience: "—" },
        trace: [ { t: 'recognition intact ▸ "came to the picnic"' }, { t: "name retrieval blocked · relationship first", cls: "risk" } ] },
      { bars: { choicert: { pct: 24, lvl: "low" }, gradcpt: { pct: 49, lvl: "low" }, dsm: { pct: 40, lvl: "low" }, mot: { pct: 45, lvl: "low" } },
        emotion: { emotion: "Confused", manner: "Default", audience: "—" },
        trace: [ { t: "relationship recalled ▸ nephew ✓", cls: "accent" }, { t: "name still blocked · tip-of-tongue", cls: "risk" } ] },
      { bars: { choicert: { pct: 36, lvl: "low" }, gradcpt: { pct: 52, lvl: "mid" }, dsm: { pct: 44, lvl: "low" }, mot: { pct: 50, lvl: "mid" } },
        emotion: { emotion: "Calm", manner: "Default", audience: "—" },
        trace: [ { t: 'phonemic cue ▸ "Ray" → Raymond ✓', cls: "accent" }, { t: "retrieval unblocked by first-sound cue" } ] },
      { bars: { choicert: { pct: 41, lvl: "low" }, gradcpt: { pct: 55, lvl: "mid" }, dsm: { pct: 49, lvl: "low" }, mot: { pct: 55, lvl: "mid" } },
        emotion: { emotion: "Calm", manner: "Default", audience: "—" },
        trace: [ { t: "full association linked ✓ nephew Raymond", cls: "accent" } ] },
    ],
  },

  // ── Scene 7 · Simple meal planning (executive sequencing) ──
  meal_planning_natural: {
    env: { chips: [{ t: "Indoor", cls: "indoor" }],
           feats: { competing: "None", ambient: "Quiet", movement: "Stationary" } },
    policy: [ { at: 0.3, step: 0 }, { at: 20, step: 1 }, { at: 24, step: 0 }, { at: 37, step: 1 }, { at: 41, step: 0 }, { at: 53, step: 4 } ],
    userStates: [
      { bars: { choicert: { pct: 38, label: "slow", lvl: "low" }, gradcpt: { pct: 50, label: "engaged", lvl: "mid" }, dsm: { pct: 34, label: "sequencing load", lvl: "low" }, mot: { pct: 42, label: "tracking", lvl: "low" } },
        emotion: { emotion: "Calm", manner: "Default", audience: "—" },
        trace: [ { t: "ingredients retrieved easily ✓" }, { t: "items ok · ordering will be hard" } ] },
      { bars: { choicert: { pct: 34, label: "reordering", lvl: "low" }, gradcpt: { pct: 48, label: "engaged", lvl: "low" }, dsm: { pct: 30, label: "sequencing load", lvl: "low" }, mot: { pct: 40, label: "tracking", lvl: "low" } },
        emotion: { emotion: "Confused", manner: "Default", audience: "—" },
        trace: [ { t: "sequencing ▸ stove-first error, self-corrected", cls: "risk" }, { t: "executive ordering needs support", cls: "accent" } ] },
      { emotion: { emotion: "Calm", manner: "Default", audience: "—" },
        trace: [ { t: "step order forming with support" } ] },
      { bars: { choicert: { pct: 42, label: "steadier", lvl: "low" }, gradcpt: { pct: 52, label: "engaged", lvl: "mid" }, dsm: { pct: 40, label: "sequence held", lvl: "low" }, mot: { pct: 48, label: "consolidated", lvl: "low" } },
        emotion: { emotion: "Calm", manner: "Default", audience: "—" },
        trace: [ { t: "sequence consolidated ✓ · safety: stove off", cls: "accent" } ] },
    ],
  },

  // ── Scene 8 · Gradient-descent tutor (capable learner · self-repair) ──
  gradient_tutor: {
    env: { chips: [{ t: "Indoor", cls: "indoor" }],
           feats: { competing: "None", ambient: "Quiet", movement: "Stationary" } },
    policy: [ { at: 0.3, step: 0 }, { at: 13.55, step: 1 }, { at: 18, step: 0 }, { at: 42.2, step: 1 }, { at: 47, step: 0 } ],
    userStates: [
      { bars: { choicert: { pct: 65, lvl: "high" }, gradcpt: { pct: 71, lvl: "high" }, dsm: { pct: 61, lvl: "high" }, mot: { pct: 65, lvl: "high" } },
        emotion: { emotion: "Calm", manner: "Default", audience: "—" },
        trace: [ { t: "heard ▸ gradient = derivative, opposite direction" }, { t: "GradCPT ▸ focused · active reasoning" } ] },
      { bars: { choicert: { pct: 67, lvl: "high" }, gradcpt: { pct: 72, lvl: "high" }, dsm: { pct: 63, lvl: "high" }, mot: { pct: 66, lvl: "high" } },
        trace: [ { t: "connects gradient direction → slope of the loss ✓", cls: "accent" } ] },
      { bars: { choicert: { pct: 68, lvl: "high" }, gradcpt: { pct: 73, lvl: "high" }, dsm: { pct: 64, lvl: "high" }, mot: { pct: 67, lvl: "high" } },
        trace: [ { t: "narrows to parameters / weights ✓", cls: "accent" } ] },
      { bars: { choicert: { pct: 70, lvl: "high" }, gradcpt: { pct: 75, lvl: "high" }, dsm: { pct: 67, lvl: "high" }, mot: { pct: 69, lvl: "high" } },
        emotion: { emotion: "Happy", manner: "Default", audience: "—" },
        trace: [ { t: 'self-repair ▸ "up, so we go down" ✓', cls: "accent" }, { t: "concept consolidating · confidence up" } ] },
    ],
  },

  // ── Scene 9 · Photosynthesis tutor (anxious, overloaded learner) ──
  photosynthesis_tutor: {
    env: { chips: [{ t: "Indoor", cls: "indoor" }],
           feats: { competing: "None", ambient: "Quiet", movement: "Stationary" } },
    policy: [ { at: 0.3, step: 0 }, { at: 34, step: 1 }, { at: 39, step: 0 }, { at: 85, step: 3 }, { at: 90, step: 0 }, { at: 149, step: 4 } ],
    userStates: [
      { bars: { choicert: { pct: 50, label: "rushing", lvl: "mid" }, gradcpt: { pct: 54, label: "effortful", lvl: "mid" }, dsm: { pct: 42, label: "overloaded", lvl: "low" }, mot: { pct: 46, label: "sequence loss", lvl: "low" } },
        emotion: { emotion: "Confused", manner: "Default", audience: "—" },
        trace: [ { t: "heard ▸ observes plant leaning to light · apologizes" }, { t: "affect ▸ anxious · self-doubt", cls: "risk" }, { t: "working memory ▸ nearing overload", cls: "risk" } ] },
      { emotion: { emotion: "Confused", manner: "Fast", audience: "—" },
        trace: [ { t: "term confusion ▸ air ↔ carbon dioxide · self-caught", cls: "risk" }, { t: "rushing when overloaded" } ] },
      { bars: { choicert: { pct: 52, label: "steadier", lvl: "mid" }, gradcpt: { pct: 58, label: "engaged", lvl: "mid" }, dsm: { pct: 48, label: "chunking helps", lvl: "low" }, mot: { pct: 50, label: "holding 3", lvl: "mid" } },
        emotion: { emotion: "Calm", manner: "Default", audience: "—" },
        trace: [ { t: "chunking ▸ holds 3 inputs ✓ · load reduced", cls: "accent" } ] },
      { trace: [ { t: "points to inputs ▸ roots, leaves ✓" } ] },
      { emotion: { emotion: "Confused", manner: "Default", audience: "—" },
        trace: [ { t: 'term confusion ▸ "pores" · accepted as close', cls: "accent" } ] },
      { bars: { choicert: { pct: 50, label: "jumpy", lvl: "mid" }, gradcpt: { pct: 56, label: "engaged", lvl: "mid" }, dsm: { pct: 50, label: "reordering", lvl: "mid" }, mot: { pct: 52, label: "tracking", lvl: "mid" } },
        emotion: { emotion: "Confused", manner: "Default", audience: "—" },
        trace: [ { t: "sequence jump ▸ found both outputs · reorders", cls: "risk" } ] },
      { trace: [ { t: "names outputs slowly ▸ sugar, oxygen ✓" } ] },
      { bars: { choicert: { pct: 56, label: "steadier", lvl: "mid" }, gradcpt: { pct: 62, label: "engaged", lvl: "high" }, dsm: { pct: 56, label: "rebuilt", lvl: "mid" }, mot: { pct: 58, label: "anchored", lvl: "mid" } },
        emotion: { emotion: "Calm", manner: "Default", audience: "—" },
        trace: [ { t: "rebuilt from parts ▸ full sentence ✓ · steadier", cls: "accent" } ] },
      { emotion: { emotion: "Calm", manner: "Default", audience: "—" },
        trace: [ { t: 'insight ▸ "anchors made the order less floaty"', cls: "accent" } ] },
    ],
  },
};

function fmtClock(sec) {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

// Rebuild both transcript rails straight from the word timings so the captions are
// the exact words in the audio, at the exact times. Each word carries its own
// start/end so the reveal is true online transcription.
function renderRails(scene, turns) {
  const userRail = scene.querySelector(".user-rail");
  const castRail = scene.querySelector(".cast-rail");
  [userRail, castRail].forEach((rail) => {
    if (rail) rail.querySelectorAll(".turn").forEach((t) => t.remove());
  });
  turns.forEach((turn) => {
    const rail = turn.speaker === "user" ? userRail : castRail;
    if (!rail) return;
    const div = document.createElement("div");
    div.className = "turn" + (turn.speaker === "cast" ? " response" : "");
    div.dataset.start = turn.start;
    div.dataset.end = turn.end;
    const span = document.createElement("span");
    span.textContent = fmtClock(turn.start);
    const p = document.createElement("p");
    p.innerHTML = turn.words
      .map((w) => `<span class="word" data-s="${w.s}" data-e="${w.e}">${w.w}</span>`)
      .join(" ");
    div.appendChild(span);
    div.appendChild(p);
    rail.appendChild(div);
  });
}

function applyEnv(scene, env) {
  if (!env) return;
  if (env.chips) {
    const wrap = scene.querySelector(".env-chips");
    if (wrap) {
      wrap.innerHTML = env.chips
        .map((c) => `<div class="env-chip${c.cls ? " " + c.cls : ""}">${c.t}</div>`)
        .join("");
    }
  }
  if (env.feats) {
    Object.entries(env.feats).forEach(([key, value]) => {
      const row = scene.querySelector(`.env-feat[data-feat="${key}"]`);
      if (!row) return;
      row.hidden = false;
      const strong = row.querySelector("strong");
      if (strong) strong.textContent = value;
    });
  }
}

function typeText(el, text, token, scene, onTick) {
  el.textContent = "";
  let i = 0;
  const step = () => {
    if (scene._runToken !== token) return;
    // Freeze the typewriter while the session is paused.
    if (scene.classList.contains("is-paused")) {
      setTimeout(step, 120);
      return;
    }
    i += 2;
    el.textContent = text.slice(0, i);
    if (onTick) onTick();
    if (i < text.length) setTimeout(step, 17);
  };
  step();
}

function typeTraceLine(box, item, token, scene) {
  if (scene._runToken !== token) return;
  const line = document.createElement("div");
  line.className = "trace-line" + (item.cls ? " " + item.cls : "");
  box.appendChild(line);
  typeText(line, item.t, token, scene, () => {
    box.scrollTop = box.scrollHeight;
  });
}

function findEmitAt(script, turnText) {
  if (!script || !turnText) return null;
  // Normalise to first ~14 alphanum chars for a loose match against emit ▸ "..." lines
  const snippet = turnText.trim().toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 14);
  const item = script.trace.find(
    (t) => t.cls === "emit" && t.t.toLowerCase().replace(/[^a-z0-9]+/g, "").includes(snippet)
  );
  return item ? item.at : null;
}

// One fixed vocabulary per cognitive metric per level — the system reports the same
// classes everywhere, not scenario-specific prose. Higher pct = better function.
const COG_LABELS = {
  choicert: { high: "Fast",     mid: "Slowed",   low: "Very slow" },   // response speed
  gradcpt:  { high: "Focused",  mid: "Wavering", low: "Drifting" },     // sustained focus
  dsm:      { high: "Clear",    mid: "Loaded",   low: "Overloaded" },   // processing load
  mot:      { high: "Tracking", mid: "Partial",  low: "Scattered" },    // attention tracking
};

function applyBars(scene, vals) {
  Object.entries(vals).forEach(([id, { pct, label, lvl }]) => {
    const bar = scene.querySelector(`.cog-bar[data-bar="${id}"]`);
    if (!bar) return;
    const fill = bar.querySelector(".cog-bar-fill");
    const val  = bar.querySelector(".cog-val");
    if (fill) { fill.style.setProperty("--pct", pct); fill.dataset.base = pct; }
    // Consistent class label from the fixed vocabulary (falls back to any passed label).
    const classed = (COG_LABELS[id] && lvl && COG_LABELS[id][lvl]) || label;
    if (val)  val.textContent = classed;
    if (lvl)  bar.dataset.level = lvl;
  });
}

// "The model is still analysing" drift: nudge each active bar around its current base
// so the read-out is visibly live between turns — WITHOUT changing the label or the
// level (the class the system reports stays fixed; only the needle breathes).
function driftBars(scene) {
  scene.querySelectorAll(".cog-bar .cog-bar-fill").forEach((fill) => {
    if (fill.dataset.base == null) return;
    const base = Number(fill.dataset.base);
    const jitter = base + (Math.random() * 6.4 - 3.2); // ±~3%, visible but subtle
    fill.style.setProperty("--pct", Math.max(5, Math.min(97, jitter)).toFixed(1));
  });
}

function applyEmotion(scene, kf) {
  const chip       = scene.querySelector(".emo-chip");
  const mannerChip = scene.querySelector(".emo-style-chip");
  const main       = scene.querySelector(".emo-main");
  const manner     = scene.querySelector(".emo-style");
  const audience   = scene.querySelector(".emo-audience");
  if (chip)       { chip.textContent = kf.emotion; chip.dataset.emotion = kf.emotion.toLowerCase(); }
  if (mannerChip) mannerChip.textContent = kf.manner;
  if (main)       main.textContent = kf.emotion;
  if (manner)     manner.textContent = kf.manner;
  if (audience)   audience.textContent = kf.audience;
}

// Interaction policy = the machine's CURRENT engagement mode. It rests on Monitor
// almost the whole call and only flicks to another rung for the instant the machine
// actually acts, then returns to Monitor. There is no accumulating trail — exactly
// one rung is active at a time.
function setActiveRung(scene, step) {
  scene.querySelectorAll(".policy-step-live").forEach((el) => {
    el.classList.toggle("is-hot", Number(el.dataset.step) === step);
    el.classList.remove("is-done", "is-na");
  });
}

// Gather every timed event this scene's stream produces (word reveals, internal
// state trace lines, cognitive bars, emotion, and policy steps) into the shared
// `events` queue. Nothing is scheduled here — the pausable clock in runScene fires
// each event when the session clock reaches its `at`.
// Build the full event queue for a run:
//   • word reveals + turn bubbles, keyed to the exact audio time of each word,
//   • state updates (cognitive / emotion / policy / environment / trace), each
//     anchored 2 s after the caller's turn that triggers them starts.
// `turns` is the grouped timing; `userStarts` are caller-turn start times (seconds).
// Captions trail the audio by this much — the words land a beat after you hear them,
// which reads as live transcription rather than a pre-print.
const CAPTION_DELAY_MS = 500;

function collectStreamEvents(scene, events, userStarts) {
  const script = streamScripts[scene.dataset.scene];
  const box = scene.querySelector(".state-stream");
  if (box) box.innerHTML = "";

  // Transcript: reveal each turn bubble at its start, each word at its own time,
  // with a moving "currently speaking" highlight (true online transcription).
  scene.querySelectorAll(".user-rail .turn, .cast-rail .turn").forEach((turn) => {
    const start = Number(turn.dataset.start || 0);
    events.push({ at: start * 1000 + CAPTION_DELAY_MS, fire: () => turn.classList.add("is-visible", "is-live") });
    const spans = [...turn.querySelectorAll(".word")];
    spans.forEach((sp) => {
      const s = Number(sp.dataset.s || 0);
      events.push({
        at: s * 1000 + CAPTION_DELAY_MS,
        fire: () => {
          spans.forEach((x) => x.classList.remove("is-speaking"));
          sp.classList.add("is-spoken", "is-speaking");
        },
      });
    });
    const end = Number(turn.dataset.end || 0);
    events.push({ at: end * 1000 + CAPTION_DELAY_MS, fire: () => spans.forEach((x) => x.classList.remove("is-speaking")) });
  });

  // Interaction policy rests on Monitor from the moment the line opens.
  events.push({ at: 300, fire: () => setActiveRung(scene, 0) });
  if (!script) return true;

  // The machine only leaves Monitor for the instant it actually acts, then returns.
  // `policy` is a timeline of {at (seconds), step} tied to CAST's real utterance times.
  (script.policy || []).forEach(({ at, step }) => {
    events.push({ at: at * 1000, fire: () => setActiveRung(scene, step) });
  });

  // Environment base appears with the caller's first words (2 s in), so the whole
  // panel lights on the caller, not the dispatcher.
  if (script.env && userStarts.length) {
    const at0 = (userStarts[0] + 2) * 1000;
    events.push({ at: at0, fire: () => applyEnv(scene, script.env) });
  }

  // Per-caller-turn state (cognitive / emotion / environment / trace): fires 2 s after
  // that caller turn begins. Turns that omit a field simply hold the previous value.
  let firstBarsAt = Infinity;
  (script.userStates || []).forEach((st, i) => {
    if (!st || i >= userStarts.length) return;
    const anchor = (userStarts[i] + 2) * 1000;
    if (st.bars)    { events.push({ at: anchor, fire: () => applyBars(scene, st.bars) }); firstBarsAt = Math.min(firstBarsAt, anchor); }
    if (st.emotion) events.push({ at: anchor, fire: () => applyEmotion(scene, st.emotion) });
    if (st.env)     events.push({ at: anchor, fire: () => applyEnv(scene, st.env) });
    if (st.trace && box) {
      st.trace.forEach((item, k) => {
        events.push({ at: anchor + k * 900, fire: () => typeTraceLine(box, item, scene._runToken, scene) });
      });
    }
  });

  // Proof-of-life: drift the bars ~once a second ONLY while the caller is talking.
  // When CAST is speaking (between the caller's turns) the read-out holds steady —
  // the model re-assesses the human as the human speaks, not while it responds.
  if (firstBarsAt !== Infinity) {
    const userWindows = [...scene.querySelectorAll(".user-rail .turn")].map((t) => [
      Number(t.dataset.start || 0) * 1000,
      Number(t.dataset.end || 0) * 1000,
    ]);
    const inUserWindow = (ms) => userWindows.some(([s, e]) => ms >= s && ms <= e);
    const driftEnd = (userStarts[userStarts.length - 1] + 20) * 1000;
    for (let t = firstBarsAt; t < driftEnd; t += 3000) {
      if (inUserWindow(t)) events.push({ at: t, fire: () => driftBars(scene) });
    }
  }
  return true;
}

audioManifest = null;

const sceneObserver = new IntersectionObserver(
  (entries) => {
    entries.forEach((entry) => {
      entry.target.classList.toggle("is-active", entry.isIntersecting);
    });
  },
  {
    rootMargin: "-28% 0px -28% 0px",
    threshold: 0.18,
  }
);

function resetScene(scene) {
  scene._runToken = (scene._runToken || 0) + 1;
  const existing = timers.get(scene) || [];
  existing.forEach((timer) => clearTimeout(timer));
  timers.set(scene, []);
  if (scene._loopTimer) { clearInterval(scene._loopTimer); scene._loopTimer = null; }

  scene.classList.remove("is-running", "is-complete", "is-paused");
  activeAudios.forEach((audio) => {
    audio.pause();
    audio.currentTime = 0;
  });
  activeAudios = [];
  scene.querySelectorAll("[data-at]").forEach((node) => {
    node.classList.remove("is-live", "is-visible");
  });
  scene.querySelectorAll(".word").forEach((word) => {
    word.classList.remove("is-spoken", "is-speaking");
  });
  scene.querySelectorAll(".signal-tick").forEach((node) => {
    node.classList.remove("signal-tick");
  });
  scene.querySelectorAll(".generated-state").forEach((node) => {
    node.style.removeProperty("--chars");
    node.classList.remove("is-typing");
  });
  const stream = scene.querySelector(".state-stream");
  if (stream) stream.innerHTML = "";
  // Reset interactive policy steps.
  scene.querySelectorAll(".policy-step-live").forEach((el) => {
    el.classList.remove("is-done", "is-hot", "is-na");
  });
  // Reset cognitive bars to neutral.
  scene.querySelectorAll(".cog-bar").forEach((bar) => {
    const fill = bar.querySelector(".cog-bar-fill");
    const val  = bar.querySelector(".cog-val");
    if (fill) { fill.style.setProperty("--pct", 50); delete fill.dataset.base; }
    if (val)  val.textContent = "—";
    bar.dataset.level = "mid";
  });
  // Reset emotion to neutral.
  const emoChip = scene.querySelector(".emo-chip");
  const emoStyleCh = scene.querySelector(".emo-style-chip");
  const emoMain = scene.querySelector(".emo-main");
  const emoStyle = scene.querySelector(".emo-style");
  const emoAudience = scene.querySelector(".emo-audience");
  if (emoChip)    { emoChip.textContent = "—"; emoChip.dataset.emotion = ""; }
  if (emoStyleCh) emoStyleCh.textContent = "—";
  if (emoMain)    emoMain.textContent = "—";
  if (emoStyle)   emoStyle.textContent = "—";
  if (emoAudience) emoAudience.textContent = "—";
  // Reset environment to neutral (chips + features clear; landmark hidden).
  const envChips = scene.querySelector(".env-chips");
  if (envChips) envChips.innerHTML = "";
  scene.querySelectorAll(".env-feat").forEach((row) => {
    const strong = row.querySelector("strong");
    if (strong) strong.textContent = "—";
    if (row.dataset.feat === "landmark") row.hidden = true;
  });
  const button = scene.querySelector(".play-session");
  if (button) button.innerHTML = "<i></i>Run session";

  scene.querySelectorAll("meter").forEach((meter) => {
    const original = originalReadouts.get(meter);
    if (original != null) meter.value = original;
  });
  scene.querySelectorAll(".metric-grid strong").forEach((node) => {
    const original = originalReadouts.get(node);
    if (original != null) node.textContent = original;
  });
}

function getScenePlayer(scene, file) {
  let audio = scenePlayers.get(scene);
  if (!audio) {
    audio = document.createElement("audio");
    audio.className = "session-audio";
    audio.preload = "auto";
    audio.playsInline = true;
    audio.setAttribute("aria-hidden", "true");
    scene.appendChild(audio);
    scenePlayers.set(scene, audio);
  }
  if (!audio.src.endsWith(file)) {
    audio.src = file;
    audio.load();
  }
  return audio;
}

function rememberOriginals(scene) {
  scene.querySelectorAll("meter").forEach((meter) => {
    if (!originalReadouts.has(meter)) originalReadouts.set(meter, Number(meter.value));
  });
  scene.querySelectorAll(".metric-grid strong").forEach((node) => {
    if (!originalReadouts.has(node)) originalReadouts.set(node, node.textContent);
  });
}

function pulseSignals(scene, step) {
  const visibleLayers = [...scene.querySelectorAll(".layer.is-visible, .layer-bars.is-visible .layer")];
  const visibleMetrics = [...scene.querySelectorAll(".science-board.is-visible .metric-grid div")];
  const visiblePolicies = [...scene.querySelectorAll(".policy-board.is-visible .policy-step")];
  const visiblePhysical = [...scene.querySelectorAll(".room-map.is-visible .physical-readout strong, .mini-room.is-visible b")];

  [...visibleLayers, ...visibleMetrics, ...visiblePolicies, ...visiblePhysical].forEach((node, index) => {
    if (index % 2 === step % 2) {
      node.classList.remove("signal-tick");
      void node.offsetWidth;
      node.classList.add("signal-tick");
    }
  });

  scene.querySelectorAll(".layer-bars.is-visible meter").forEach((meter, index) => {
    const base = originalReadouts.get(meter) ?? Number(meter.value);
    const drift = ((step + index) % 3) - 1;
    meter.value = Math.max(8, Math.min(96, base + drift * 5));
  });

  scene.querySelectorAll(".science-board.is-visible .metric-grid strong").forEach((node, index) => {
    const base = originalReadouts.get(node) ?? node.textContent;
    const match = String(base).match(/^(\d+)%$/);
    if (!match) return;
    const drift = ((step + index) % 3) - 1;
    node.textContent = `${Math.max(5, Math.min(97, Number(match[1]) + drift * 3))}%`;
  });
}

function normalizeText(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function findTurn(scene, event) {
  const candidates = [...scene.querySelectorAll(".turn")];
  const wanted = normalizeText(event.text);
  return candidates.find((turn) => normalizeText(turn.querySelector("p")?.textContent || "") === wanted);
}

function applyAudioTimings(scene) {
  const sceneName = scene.dataset.scene;
  const audioEvents = audioManifest?.scenes?.[sceneName] || [];
  audioEvents.forEach((event) => {
    const turn = findTurn(scene, event);
    if (turn) turn.dataset.at = String(event.at || 0);
  });
}

function prepareWords(turn, words) {
  const p = turn?.querySelector("p");
  if (!p || p.dataset.wordWrapped === "true") return p;
  p.innerHTML = words
    .map((word, index) => `<span class="word" data-word-index="${index}">${word.w}</span>`)
    .join(" ");
  p.dataset.wordWrapped = "true";
  return p;
}

function trackTranscript(audio, turn, words) {
  const p = prepareWords(turn, words);
  if (!p) return;
  const spans = [...p.querySelectorAll(".word")];
  const tick = () => {
    if (audio.paused || audio.ended) return;
    const time = audio.currentTime;
    spans.forEach((span, index) => {
      const word = words[index];
      const active = word && time >= word.s && time <= word.e;
      const spoken = word && time > word.e;
      span.classList.toggle("is-speaking", active);
      span.classList.toggle("is-spoken", spoken);
    });
    requestAnimationFrame(tick);
  };
  audio.addEventListener("play", tick, { once: true });
  audio.addEventListener("ended", () => {
    spans.forEach((span) => {
      span.classList.remove("is-speaking");
      span.classList.add("is-spoken");
    });
  });
}

function prepareSceneWords(scene, audioEvents) {
  audioEvents.forEach((event) => {
    const turn = findTurn(scene, event);
    if (turn && event.words) prepareWords(turn, event.words);
  });
}

function trackSceneTranscript(audio, scene, audioEvents) {
  const tracked = audioEvents
    .map((event) => {
      const turn = findTurn(scene, event);
      const p = turn && event.words ? prepareWords(turn, event.words) : null;
      return {
        at: Number(event.at || 0) / 1000,
        words: event.words || [],
        spans: p ? [...p.querySelectorAll(".word")] : [],
      };
    })
    .filter((item) => item.spans.length);

  const tick = () => {
    if (audio.paused || audio.ended) return;
    const time = audio.currentTime;
    tracked.forEach((item) => {
      const local = time - item.at;
      item.spans.forEach((span, index) => {
        const word = item.words[index];
        const active = word && local >= word.s && local <= word.e;
        const spoken = word && local > word.e;
        span.classList.toggle("is-speaking", active);
        span.classList.toggle("is-spoken", spoken);
      });
    });
    requestAnimationFrame(tick);
  };
  audio.addEventListener("play", tick, { once: true });
  audio.addEventListener("ended", () => {
    tracked.forEach((item) => {
      item.spans.forEach((span) => {
        span.classList.remove("is-speaking");
        span.classList.add("is-spoken");
      });
    });
  });
}

function setSceneTranscriptTime(scene, audioEvents, time) {
  audioEvents.forEach((event) => {
    const turn = findTurn(scene, event);
    const p = turn && event.words ? prepareWords(turn, event.words) : null;
    if (!p) return;
    const local = time - Number(event.at || 0) / 1000;
    const spans = [...p.querySelectorAll(".word")];
    spans.forEach((span, index) => {
      const word = event.words[index];
      const active = word && local >= word.s && local <= word.e;
      const spoken = word && local > word.e;
      span.classList.toggle("is-speaking", active);
      span.classList.toggle("is-spoken", spoken);
    });
  });
}

function startClockTranscript(scene, audioEvents, durationMs) {
  const token = scene._runToken;
  const startedAt = performance.now();
  const tick = (now) => {
    if (scene._runToken !== token) return;
    const elapsed = (now - startedAt) / 1000;
    setSceneTranscriptTime(scene, audioEvents, elapsed);
    if (elapsed * 1000 < durationMs) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

function playSceneAudio(scene, sceneAudio, audioEvents) {
  if (!sceneAudio?.file) return false;
  const audio = getScenePlayer(scene, sceneAudio.file);
  audio.currentTime = 0;
  audio.volume = 1;
  activeAudios.push(audio);
  prepareSceneWords(scene, audioEvents);
  trackSceneTranscript(audio, scene, audioEvents);
  audio.play().catch(() => {
    const button = scene.querySelector(".play-session");
    if (button) button.innerHTML = "<i></i>Tap again for audio";
    startClockTranscript(scene, audioEvents, Number(sceneAudio.duration || 40) * 1000);
    console.warn("CAST audio playback was blocked by the browser for", scene.dataset.scene);
  });
  return true;
}

function updateInternalState(scene, text) {
  const state = scene.querySelector(".generated-state p");
  const shell = scene.querySelector(".generated-state");
  if (!state || !shell) return;
  shell.classList.remove("is-typing");
  state.textContent = text;
  void shell.offsetWidth;
  shell.classList.add("is-visible", "is-typing");
}

function playEventAudio(scene, event) {
  if (!event.file) return;
  const audio = new Audio(event.file);
  audio.preload = "auto";
  audio.volume = event.role === "cast" ? 0.82 : 1;
  activeAudios.push(audio);
  const turn = findTurn(scene, event);
  if (turn && event.words) trackTranscript(audio, turn, event.words);
  audio.play().catch(() => {
    const button = scene.querySelector(".play-session");
    if (button) button.innerHTML = "<i></i>Tap again for audio";
  });
}

// One session, one master clock — the audio itself. The transcript rails are
// rebuilt from the real word timings, then every timed thing (word reveals, turn
// bubbles, cognitive bars, emotion, policy, environment, trace) is queued by its
// audio time. The loop reads audio.currentTime each frame, so captions and states
// line up with what you hear to the word, and pausing the audio freezes everything.
async function runScene(scene) {
  resetScene(scene);
  rememberOriginals(scene);
  scene.classList.add("is-running");
  const token = scene._runToken;
  const button = scene.querySelector(".play-session");
  if (button) button.innerHTML = "<i></i>Pause";

  // Pull real word timings and rebuild the rails from them.
  const turns = await ensureTiming(scene.dataset.scene);
  if (scene._runToken !== token) return; // reset/replay landed during the await
  if (turns) renderRails(scene, turns);
  const userStarts = (turns || []).filter((t) => t.speaker === "user").map((t) => t.start);

  const events = [];
  // State-feed box (and any other [data-at] node) reveals on its own timeline.
  scene.querySelectorAll("[data-at]").forEach((node) => {
    events.push({
      at: Number(node.dataset.at || 0),
      fire: () => node.classList.add("is-visible", "is-live"),
    });
  });
  collectStreamEvents(scene, events, userStarts);
  events.sort((a, b) => a.at - b.at);

  const lastEventAt = events.reduce((max, e) => Math.max(max, e.at), 0);
  const durationMs = lastEventAt + 2800;

  // Session audio — the master clock.
  let audio = null;
  if (scene.dataset.audio) {
    audio = getScenePlayer(scene, scene.dataset.audio);
    audio.currentTime = 0;
    audio.volume = 1;
    activeAudios.push(audio);
    audio.play().catch(() => {
      if (button) button.innerHTML = "<i></i>Tap again for audio";
    });
  }

  // Clock: slave to audio.currentTime whenever the audio is actually advancing;
  // otherwise fall back to a wall clock so the demo still runs if autoplay is blocked.
  // Driven by a timer (not requestAnimationFrame) so it keeps running even if the
  // presenter switches tabs — rAF is paused in background tabs, a timer is not.
  const clock = { start: performance.now() };
  scene._clock = clock;
  let idx = 0;
  if (scene._loopTimer) clearInterval(scene._loopTimer);

  const tick = () => {
    if (scene._runToken !== token) { clearInterval(scene._loopTimer); return; }
    if (scene.classList.contains("is-paused")) return; // frozen: audio + clock both held
    let elapsed;
    if (audio && !audio.paused && audio.readyState >= 2 && audio.currentTime > 0) {
      elapsed = audio.currentTime * 1000;
      clock.start = performance.now() - elapsed; // keep the fallback clock in sync
    } else {
      elapsed = performance.now() - clock.start;
    }
    while (idx < events.length && events[idx].at <= elapsed) {
      try { events[idx].fire(); } catch (err) { /* keep the session alive */ }
      idx++;
    }
    if (elapsed >= durationMs) {
      clearInterval(scene._loopTimer);
      scene._loopTimer = null;
      scene.classList.remove("is-running");
      scene.classList.add("is-complete");
      if (button) button.innerHTML = "<i></i>Replay";
    }
  };
  scene._loopTimer = setInterval(tick, 55);
  tick();
}

scenes.forEach((scene, index) => {
  sceneObserver.observe(scene);
  scene.style.setProperty("--scene-index", index);
  rememberOriginals(scene);
  resetScene(scene);
});

document.querySelectorAll(".play-session").forEach((button) => {
  button.addEventListener("click", () => {
    const scene = button.closest(".story-scene");
    if (!scene) return;
    if (scene.classList.contains("is-paused")) {
      // Resume — advance the clock's start by however long we sat paused, so the
      // event queue picks up exactly where it left off (words + states + audio).
      if (scene._clock && scene._clock.pausedAt != null) {
        scene._clock.start += performance.now() - scene._clock.pausedAt;
        scene._clock.pausedAt = null;
      }
      scene.classList.remove("is-paused");
      activeAudios.forEach((a) => a.play().catch(() => {}));
      button.innerHTML = "<i></i>Pause";
    } else if (scene.classList.contains("is-running")) {
      // Pause — freeze the clock and the audio at the same instant.
      if (scene._clock) scene._clock.pausedAt = performance.now();
      scene.classList.add("is-paused");
      activeAudios.forEach((a) => a.pause());
      button.innerHTML = "<i></i>Resume";
    } else {
      runScene(scene);
    }
  });
});

document.querySelectorAll(".missing-toggle").forEach((btn) => {
  btn.addEventListener("click", () => {
    const accordion = btn.closest(".missing-accordion");
    const body = accordion.querySelector(".missing-body");
    const open = accordion.classList.toggle("is-open");
    btn.setAttribute("aria-expanded", String(open));
    if (open) {
      body.removeAttribute("hidden");
      requestAnimationFrame(() => body.classList.add("is-visible"));
    } else {
      body.classList.remove("is-visible");
      body.addEventListener("transitionend", () => body.setAttribute("hidden", ""), { once: true });
    }
  });
});

document.querySelectorAll(".panel-toggle").forEach((btn) => {
  btn.addEventListener("click", () => {
    const panel = btn.closest(".research-panel");
    const body = panel.querySelector(".panel-body");
    const open = panel.classList.toggle("is-open");
    btn.setAttribute("aria-expanded", String(open));
    if (open) {
      body.removeAttribute("hidden");
      requestAnimationFrame(() => body.classList.add("is-visible"));
    } else {
      body.classList.remove("is-visible");
      body.addEventListener("transitionend", () => body.setAttribute("hidden", ""), { once: true });
    }
  });
});

// Collapsible extra-scenario bars: each expands to reveal a full runnable scene.
document.querySelectorAll(".scenario-toggle").forEach((btn) => {
  btn.addEventListener("click", () => {
    const panel = btn.closest(".scenario-panel");
    const body = panel.querySelector(".scenario-body");
    const open = panel.classList.toggle("is-open");
    btn.setAttribute("aria-expanded", String(open));
    if (open) body.removeAttribute("hidden");
    else body.setAttribute("hidden", "");
  });
});
