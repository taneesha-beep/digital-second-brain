#!/usr/bin/env python3
"""validate_metrics.py — roadmap 2.4.

Diffs backend/eval/metrics.js against pytrec_eval, the Python binding onto
trec_eval's C source, per query and in aggregate. Writes the diff to
results/metric-validation.txt and exits non-zero if anything disagrees beyond
the tolerance.

WHAT THIS IS FOR, AND WHAT IT IS NOT. A subtly wrong nDCG invalidates every
number this project will ever quote, and nDCG has published variants that
disagree — so "internally consistent" and "correct" are different properties and
only the second one travels. pytrec_eval is authoritative on exactly one
question: what does trec_eval compute. It is NOT an oracle on what this project
should compute. EVALUATION.md §9.1 states the conventions, and it was written
before this check ran precisely so a disagreement can be sorted into "the code
does not implement its own spec" (a bug) versus "the spec differs from
trec_eval's" (a convention difference). Those need opposite responses.

THE FOUR-STEP LADDER. Three things separate this harness from trec_eval, and
running them together would produce one unattributable delta. So they are peeled
off one at a time, which is CLAUDE.md's never-change-two-variables rule applied
to the validation itself:

    A  raw            pytrec_eval as it comes: its own qrels, the score column
                      as written, its own query population
    B  + zero-result  reinsert the qids the retriever returned nothing for,
                      scored 0 (what `trec_eval -c` does, and what §9.1 says)
    C  + tie order    replace the score column with a strictly decreasing
                      function of the run file's rank column
    D  + gain         qrels grades mapped through 2^g - 1

Step D is where the 1e-6 claim is made. The deltas at A->B, B->C and C->D are
the measured size of each difference, reported rather than bridged silently.

Usage:
    scripts/.venv/bin/python scripts/validate_metrics.py
    npm run validate:metrics          # from backend/
"""

import hashlib
import json
import math
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
OUT_FILE = REPO_ROOT / "results" / "metric-validation.txt"
TOLERANCE = 1e-6
KS = [1, 5, 8, 10]

# The two run files 2.4's criterion asks for ("at least two"). Both are dev runs
# of the same retriever differing in one param, so the pair also checks that
# agreement is not an artefact of one result-length distribution: the capped run
# returns exactly 8 for 94.7% of queries and the uncapped one returns 10 for
# 92.7%, which exercise opposite sides of §9.1's DCG-truncates-at-what-you-
# returned asymmetry.
RUN_LABELS = ["v1-overlap", "v1-overlap-uncapped"]
SPLIT = "dev"
SITE = "cooking"

try:
    import pytrec_eval
except ImportError:  # pragma: no cover - setup guidance, not logic
    sys.exit(
        "pytrec_eval is not importable.\n"
        "  python3 -m venv scripts/.venv\n"
        "  scripts/.venv/bin/pip install --require-hashes -r scripts/requirements.txt\n"
        "  scripts/.venv/bin/python scripts/validate_metrics.py"
    )


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_inputs(sidecar):
    """Recompute every input hash the run recorded.

    The sidecar's hashes were themselves recomputed at run time rather than
    copied from the Phase 1 manifests (EVALUATION.md §8.1). Recomputing them
    again here is what makes this validation about the bytes on disk now, not
    about a claim in a JSON file. A validation run against inputs that have
    silently moved would certify nothing.
    """
    rows = []
    for entry in sidecar["inputs"]:
        actual = sha256_file(REPO_ROOT / entry["file"])
        rows.append((entry["name"], entry["file"], entry["sha256"], actual,
                     actual == entry["sha256"]))
    return rows


def parse_run_file(path):
    """qid -> [(rank, docid, score)], sorted by the rank column."""
    runs = {}
    with open(path) as handle:
        for line in handle:
            if not line.strip():
                continue
            qid, _, docid, rank, score, _runid = line.split()
            runs.setdefault(qid, []).append((int(rank), docid, float(score)))
    for qid in runs:
        runs[qid].sort()
    return runs


def parse_qrels(path):
    """qid -> {docid: grade}."""
    qrels = {}
    with open(path) as handle:
        for line in handle:
            if not line.strip():
                continue
            qid, _, docid, grade = line.split()
            qrels.setdefault(qid, {})[docid] = int(grade)
    return qrels


def read_split(path):
    with open(path) as handle:
        return [line.strip() for line in handle if line.strip()]


# ---------------------------------------------------------------------------
# The Node bridge — the scorer under audit
# ---------------------------------------------------------------------------

def score_with_metrics_js(run_file, qrels_file, split_file, corpus_file):
    """Per-query and aggregate scores straight out of backend/eval/metrics.js.

    Shelled out rather than reimplemented. §9.3 already records an independent
    Python recomputation that matched every digit and states what it could not
    establish, since the same conventions were implemented twice by the same
    person. Re-deriving them here a third time would inherit that same blind
    spot; calling the real module cannot.
    """
    result = subprocess.run(
        ["node", str(REPO_ROOT / "scripts" / "emit-per-query-scores.js"),
         "--run", str(run_file), "--qrels", str(qrels_file),
         "--split", str(split_file), "--corpus", str(corpus_file),
         "--ks", ",".join(str(k) for k in KS)],
        capture_output=True, text=True, check=False)
    if result.returncode != 0:
        sys.exit(f"emit-per-query-scores.js failed:\n{result.stderr}")
    return json.loads(result.stdout)


# ---------------------------------------------------------------------------
# pytrec_eval
# ---------------------------------------------------------------------------

MEASURES = {
    "ndcg_cut." + ",".join(str(k) for k in KS),
    "P." + ",".join(str(k) for k in KS),
    "recall." + ",".join(str(k) for k in KS),
    "recip_rank",
}

# metrics.js name -> pytrec_eval name, at each k
NAME_MAP = [("ndcg", "ndcg_cut_{k}"), ("p", "P_{k}"), ("r", "recall_{k}")]


def gain_transform(qrels):
    """grade g -> 2^g - 1, i.e. 1 -> 1 and 2 -> 3.

    trec_eval's ndcg_cut uses LINEAR gain and, unlike `ndcg`, takes no gain
    parameter — its own documentation says so: "Gain values are the relevance
    values in the qrels file. For now, if you want different gains, change the
    qrels file appropriately." So this is the mechanism the reference tool
    documents, not a workaround around it.

    It is exact, not approximate. trec_eval's linear-gain DCG over transformed
    grades is identically §9.1's exponential-gain DCG over the originals, and
    the IDCGs match too because 2^g - 1 is strictly increasing in g, so sorting
    grades descending and sorting gains descending are the same order.

    P and R are unaffected: trec_eval binarises at rel_level=1 and both 1 and 3
    clear it. bpref's judged-nonrelevant set is grade <= 0 and stays empty.
    """
    return {qid: {docid: (2 ** grade) - 1 for docid, grade in judged.items()}
            for qid, judged in qrels.items()}


def as_scored_run(runs, use_rank_order):
    """Shape the run for pytrec_eval, optionally forcing the rank column's order.

    TREC treats the score column as authoritative and trec_eval discards rank
    entirely, re-sorting by score and breaking ties on docid DESCENDING (probed,
    not assumed - see the fixture section). This harness treats rank as
    authoritative, because retrieval/index.js fixed the order before the file
    was written: descending score, then lexicographic ASCENDING on the id.

    Those two rules disagree on every tie, and ties are not an edge case here.
    v1's scores take 18 distinct values across the whole dev run, so 88.2% of
    adjacent pairs in the capped run file are score ties and 99.3% of queries
    contain at least one. Handing the raw score column to a tool that re-sorts
    it therefore compares two different rankings, which is not what a metric
    validation is trying to find out.

    With use_rank_order, the score becomes 1/rank: strictly decreasing, unique
    within a query, so trec_eval's sort reproduces the rank column exactly and
    no tie survives to be broken. Both variants are run, so the cost of the
    difference is measured rather than assumed away.
    """
    shaped = {}
    for qid, rows in runs.items():
        if use_rank_order:
            shaped[qid] = {docid: 1.0 / rank for rank, docid, _score in rows}
        else:
            shaped[qid] = {docid: score for _rank, docid, score in rows}
    return shaped


def evaluate(qrels, run, measures=MEASURES):
    return pytrec_eval.RelevanceEvaluator(qrels, measures).evaluate(run)


def fill_missing_queries(results, query_ids, measures_flat):
    """Score 0 for split queries pytrec_eval did not return.

    RelevanceEvaluator.evaluate() iterates the RUN, so a query the retriever
    returned nothing for has no lines, never appears, and would silently drop
    out of the denominator. §8.3 made returning nothing score 0 and stay in the
    mean on purpose: excluding those queries inflates every metric by exactly
    the failure rate. `trec_eval -c` does the same thing. Measured on dev this
    is 11 queries of 2,304 - small, and small in the direction that flatters.
    """
    filled = dict(results)
    added = []
    for qid in query_ids:
        if qid not in filled:
            filled[qid] = {m: 0.0 for m in measures_flat}
            added.append(qid)
    return filled, added


def mean_over(results, query_ids, measure):
    values = [results[qid][measure] for qid in query_ids if qid in results]
    return sum(values) / len(values) if values else float("nan")


def flat_measure_names():
    names = []
    for _mine, template in NAME_MAP:
        names.extend(template.format(k=k) for k in KS)
    names.append("recip_rank")
    return names


# ---------------------------------------------------------------------------
# Comparison
# ---------------------------------------------------------------------------

def compare_aggregates(mine, theirs, query_ids):
    """[(label, mine, theirs, delta)] for every metric at every k."""
    rows = []
    for mine_key, template in NAME_MAP:
        for k in KS:
            their_name = template.format(k=k)
            a = mine["aggregate"][mine_key][str(k)]
            b = mean_over(theirs, query_ids, their_name)
            rows.append((their_name, a, b, a - b))
    a = mine["aggregate"]["mrr"]
    b = mean_over(theirs, query_ids, "recip_rank")
    rows.append(("recip_rank", a, b, a - b))
    return rows


def compare_per_query(mine, theirs, query_ids):
    """Every metric at every k for every query. Returns (comparisons, failures).

    Per query rather than aggregate only, because an aggregate can agree while
    individual queries cancel out — two errors of opposite sign in a mean over
    2,304 queries is not an exotic failure, it is the ordinary one. This is
    2,304 x 13 = 29,952 comparisons per run file.
    """
    failures = []
    count = 0
    for qid in query_ids:
        theirs_q = theirs.get(qid)
        mine_q = mine["perQuery"][qid]
        if theirs_q is None:
            failures.append((qid, "MISSING", float("nan"), float("nan"), float("nan")))
            continue
        for mine_key, template in NAME_MAP:
            for k in KS:
                a = mine_q[mine_key][str(k)]
                if a is None:
                    continue  # unjudgeable: null by §9.1, and excluded upstream
                b = theirs_q[template.format(k=k)]
                count += 1
                if abs(a - b) > TOLERANCE:
                    failures.append((qid, template.format(k=k), a, b, a - b))
        a = mine_q["mrr"]
        b = theirs_q["recip_rank"]
        count += 1
        if abs(a - b) > TOLERANCE:
            failures.append((qid, "recip_rank", a, b, a - b))
    return count, failures


def max_abs_delta(mine, theirs, query_ids):
    worst = (0.0, None, None)
    for qid in query_ids:
        theirs_q = theirs.get(qid)
        if theirs_q is None:
            continue
        mine_q = mine["perQuery"][qid]
        for mine_key, template in NAME_MAP:
            for k in KS:
                a = mine_q[mine_key][str(k)]
                if a is None:
                    continue
                d = abs(a - theirs_q[template.format(k=k)])
                if d > worst[0]:
                    worst = (d, qid, template.format(k=k))
        d = abs(mine_q["mrr"] - theirs_q["recip_rank"])
        if d > worst[0]:
            worst = (d, qid, "recip_rank")
    return worst


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

class Report:
    def __init__(self):
        self.lines = []

    def __call__(self, text=""):
        self.lines.append(text)
        print(text)

    def rule(self, char="-"):
        self(char * 78)

    def write(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("\n".join(self.lines) + "\n")


def fmt(value):
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "       nan"
    return f"{value:10.6f}"


def fmt_delta(value):
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return "        nan"
    return f"{value:+.3e}"


# ---------------------------------------------------------------------------
# Fixtures — behaviours probed rather than read off documentation
# ---------------------------------------------------------------------------

def probe_reference_behaviour(out):
    """Four things the diff would otherwise attribute to the wrong cause.

    Every one of these was a suspicion before it was a measurement, and each is
    checked against the installed binary rather than against its documentation,
    because the documentation for two of them is silent or wrong.
    """
    out()
    out("2. WHAT THE REFERENCE ACTUALLY DOES  (probed against the installed binary)")
    out.rule()

    # 1 — tie-break direction
    ev = pytrec_eval.RelevanceEvaluator({"q": {"docB": 1}}, {"ndcg_cut.1"})
    tie = ev.evaluate({"q": {"docA": 1.0, "docB": 1.0}})["q"]["ndcg_cut_1"]
    tie_rule = "docid DESCENDING" if tie == 1.0 else "docid ASCENDING"
    out(f"  tie-break on equal scores   {tie_rule}")
    out(f"    two docs tied at 1.0, only the lexicographically LATER one judged")
    out(f"    relevant -> ndcg_cut_1 = {tie:.1f}")
    out(f"    retrieval/index.js sorts ties docid ASCENDING (EVALUATION.md §7.2),")
    out(f"    so the two rules are opposites. Step C is what removes this.")
    out()

    # 2 — missing qids
    ev = pytrec_eval.RelevanceEvaluator({"q1": {"d1": 1}, "q2": {"d9": 1}},
                                        {"ndcg_cut.10"})
    returned = sorted(ev.evaluate({"q1": {"d1": 1.0}}).keys())
    out(f"  queries with no run lines   OMITTED from the output entirely")
    out(f"    qrels holds q1 and q2, run holds only q1 -> evaluate() returns "
        f"{returned}")
    out(f"    Aggregating that directly divides by the wrong N. Step B is what")
    out(f"    removes this; §9.1 scores them 0 and keeps them in the mean.")
    out()

    # 3 — gain formula
    ev = pytrec_eval.RelevanceEvaluator({"q": {"hi": 2, "lo": 1}}, {"ndcg_cut.2"})
    got = ev.evaluate({"q": {"lo": 2.0, "hi": 1.0}})["q"]["ndcg_cut_2"]
    log2_3 = math.log2(3)
    linear = (1 + 2 / log2_3) / (2 + 1 / log2_3)
    exponential = (1 + 3 / log2_3) / (3 + 1 / log2_3)
    out(f"  gain formula (ndcg_cut)     LINEAR, gain = grade")
    out(f"    grade-1 doc at rank 1, grade-2 doc at rank 2:")
    out(f"      pytrec_eval             {got:.16f}")
    out(f"      linear-gain prediction  {linear:.16f}   <- matches")
    out(f"      2^g-1 prediction (§9.1) {exponential:.16f}")
    out(f"    A {abs(got - exponential):.4f} difference on one query, not a rounding")
    out(f"    error. 2,756 of 16,678 judgments are grade 2, so this is visible")
    out(f"    on the real key. Step D is what removes it.")
    out()

    # 4 — MRR depth
    deep_qrels = {"q": {"hit": 1}}
    deep_run = {"q": {f"miss{i:02d}": float(30 - i) for i in range(14)}}
    deep_run["q"]["hit"] = 30.0 - 14
    ev = pytrec_eval.RelevanceEvaluator(deep_qrels, {"recip_rank"})
    deep = ev.evaluate(deep_run)["q"]["recip_rank"]
    truncated_list = [f"miss{i:02d}" for i in range(10)]
    from_js = subprocess.run(
        ["node", "-e",
         "const m=require(process.argv[1]);"
         "process.stdout.write(String(m.reciprocalRank(JSON.parse(process.argv[2]),"
         "new Map(Object.entries(JSON.parse(process.argv[3]))))));",
         str(REPO_ROOT / "backend" / "eval" / "metrics.js"),
         json.dumps(truncated_list), json.dumps({"hit": 1})],
        capture_output=True, text=True, check=True).stdout
    out(f"  recip_rank depth            searches the WHOLE run file")
    out(f"    first relevant document at rank 15:")
    out(f"      pytrec_eval on the full 15-deep run   {deep:.6f}  (= 1/15)")
    out(f"      metrics.js on the list truncated at 10 {float(from_js):.6f}")
    out(f"    Both are correct about the list they were given. The reported MRR")
    out(f"    is therefore recip_rank@10 — the runner truncates at k=10 before")
    out(f"    the scorer sees anything, so agreement on the dev runs below is")
    out(f"    real but conditional on that truncation, not on the definition")
    out(f"    being depth-unbounded. Labelled MRR@10 from here on.")
    return {"tie_rule": tie_rule, "missing_omitted": returned == ["q1"],
            "gain": "linear", "deep_rr": deep, "truncated_rr": float(from_js)}


def measure_bpref(out, qrels, runs_by_label, query_ids_by_label):
    """bpref on a positive-only key, measured rather than predicted.

    Roadmap 2.4's flag predicts bpref degenerates to a vacuous ~1.00 here
    because the judged-nonrelevant set is empty. Working the definition gives a
    different answer:

        bpref = (1/R) * sum over RETRIEVED relevant docs of
                (1 - |judged-nonrel ranked above| / min(R, N))

    With N = 0 no penalty term can be non-zero, so every retrieved relevant doc
    contributes 1 and every unretrieved one contributes nothing — which is
    (relevant retrieved)/R, i.e. recall at the run's depth. Not 1.00.

    The distinction matters for what gets written down. A vacuous 1.00 is
    visibly broken. A plausible ~0.19 that tracks a rung-by-rung ladder while
    being R@10 under another name is the kind of column that survives review.
    Either way no bpref column ships; the reason has to be the measured one.
    """
    out()
    out("5. bpref ON A POSITIVE-ONLY KEY  (roadmap 2.4's open question)")
    out.rule()
    out("  All 16,678 judgments are positive (EVALUATION.md §5.1), so the")
    out("  judged-nonrelevant set bpref exists to count is empty.")
    out()
    out(f"  {'run':<24} {'bpref':>10} {'recall_1000':>12}   equal?")
    findings = []
    for label in RUN_LABELS:
        run = as_scored_run(runs_by_label[label], use_rank_order=True)
        query_ids = query_ids_by_label[label]
        results = evaluate(qrels, run, {"bpref", "recall.1000"})
        results, _ = fill_missing_queries(results, query_ids, ["bpref", "recall_1000"])
        b = mean_over(results, query_ids, "bpref")
        r = mean_over(results, query_ids, "recall_1000")
        same = abs(b - r) < 1e-12
        out(f"  {label:<24} {b:10.6f} {r:12.6f}   {'yes' if same else 'NO'}")
        findings.append((label, b, r, same))
    out()
    if all(f[3] for f in findings):
        out("  MEASURED: bpref is identically recall at the run's depth, to 1e-12.")
        out("  The roadmap's predicted vacuous ~1.00 is WRONG, and the real")
        out("  degeneracy is worse in the way that matters: 1.00 announces itself,")
        out("  a plausible number that silently duplicates an existing column does")
        out("  not. Decision unchanged — no bpref column — reason corrected.")
    else:
        out("  bpref is NOT identically recall here. Investigate before writing")
        out("  anything about the degeneracy in either direction.")
    return findings


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    out = Report()
    corpus_file = REPO_ROOT / "data" / "corpus" / f"{SITE}.jsonl"
    qrels_file = REPO_ROOT / "data" / "qrels" / f"{SITE}.qrels"
    split_file = REPO_ROOT / "data" / "splits" / f"{SITE}.{SPLIT}.txt"

    git_commit = subprocess.run(
        ["git", "-C", str(REPO_ROOT), "rev-parse", "HEAD"],
        capture_output=True, text=True, check=True).stdout.strip()
    node_version = subprocess.run(
        ["node", "--version"], capture_output=True, text=True,
        check=True).stdout.strip()

    out("METRIC VALIDATION — backend/eval/metrics.js vs pytrec_eval")
    out("roadmap 2.4 · " + datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ"))
    out.rule("=")
    out()
    out("1. ENVIRONMENT")
    out.rule()
    out(f"  reference        pytrec-eval-terrier {pytrec_eval.__version__}")
    out( "                   wheel pytrec_eval_terrier-0.5.10-cp39-cp39-"
         "macosx_10_9_universal2.whl")
    out( "                   sha256 2afaff86a8eb66a766c996fb8955f6c0c601bc2b78ff"
         "678412de394f60a965d7")
    out( "                   hash-pinned in scripts/requirements.txt, installed")
    out( "                   with pip --require-hashes")
    out(f"  supported_measures {len(pytrec_eval.supported_measures)} "
        f"(fingerprint of the vendored trec_eval C source; the")
    out( "                   compiled artifact carries no extractable version "
         "string,")
    out( "                   so the C version is NOT claimed here)")
    out(f"  python           {sys.version.split()[0]} · {sys.platform}")
    out(f"  node             {node_version}")
    out(f"  git commit       {git_commit}")
    out(f"  tolerance        {TOLERANCE:g}")

    reference = probe_reference_behaviour(out)

    qrels = parse_qrels(qrels_file)
    qrels_gain = gain_transform(qrels)
    measures_flat = flat_measure_names()
    query_ids_all = read_split(split_file)

    runs_by_label = {}
    query_ids_by_label = {}
    all_passed = True
    ladder_summary = []

    for section, label in enumerate(RUN_LABELS, start=3):
        run_file = REPO_ROOT / "results" / "runs" / f"{label}.{SPLIT}.run"
        sidecar_file = Path(str(run_file) + ".json")
        if not run_file.exists():
            sys.exit(f"missing {run_file}\n  regenerate: cd backend && npm run eval "
                     f"-- --retriever v1-overlap --split {SPLIT}")
        sidecar = json.loads(sidecar_file.read_text())

        out()
        out(f"{section}. RUN: {label}.{SPLIT}")
        out.rule("=")
        out(f"  runid            {sidecar['runId']}")
        out(f"  params           {json.dumps(sidecar['retriever']['params'])}")
        out(f"  digest           {sidecar['retriever']['digest']}")
        out()
        out("  inputs, SHA-256 recomputed now (not read from the sidecar):")
        for name, path, recorded, actual, ok in verify_inputs(sidecar):
            mark = "match" if ok else "MISMATCH"
            out(f"    {name:<8} {path:<32} {actual[:16]}…  {mark}")
            if not ok:
                sys.exit(f"input {path} has changed since the run was recorded")

        mine = score_with_metrics_js(run_file, qrels_file, split_file, corpus_file)
        runs = parse_run_file(run_file)
        runs_by_label[label] = runs
        query_ids = query_ids_all
        query_ids_by_label[label] = query_ids

        # Cross-check: the bridge reads the WRITTEN run file, the runner scored an
        # in-memory list. If those disagree the bridge is not measuring the harness.
        out()
        out("  bridge cross-check — metrics.js over the written run file vs the")
        out("  aggregate the runner recorded in its committed sidecar:")
        exact = True
        for mine_key, _template in NAME_MAP:
            for k in KS:
                if mine["aggregate"][mine_key][str(k)] != sidecar["metrics"][mine_key][str(k)]:
                    exact = False
        if mine["aggregate"]["mrr"] != sidecar["metrics"]["mrr"]:
            exact = False
        out(f"    all 13 aggregate values identical to exact float equality: "
            f"{'yes' if exact else 'NO'}")
        if not exact:
            sys.exit("bridge does not reproduce the runner's own aggregate")
        out(f"    judgments dropped outside corpus: "
            f"{mine['judgmentsDroppedOutsideCorpus']}")
        out(f"    queries {mine['aggregate']['queries']} · "
            f"scored {mine['aggregate']['scored']} · "
            f"unjudgeable {mine['aggregate']['unjudgeable']} · "
            f"zero-result {mine['aggregate']['zeroResult']}")

        # ---- the four-step ladder -------------------------------------------
        out()
        out("  LADDER — one variable per step, aggregate nDCG@8 shown")
        out.rule()

        steps = []

        raw = evaluate(qrels, as_scored_run(runs, use_rank_order=False))
        steps.append(("A  raw", raw, query_ids_all, len(raw)))

        filled_b, added = fill_missing_queries(raw, query_ids_all, measures_flat)
        steps.append((f"B  + zero-result qids ({len(added)})", filled_b,
                      query_ids_all, len(filled_b)))

        tie = evaluate(qrels, as_scored_run(runs, use_rank_order=True))
        filled_c, _ = fill_missing_queries(tie, query_ids_all, measures_flat)
        steps.append(("C  + rank-order ties", filled_c, query_ids_all, len(filled_c)))

        final = evaluate(qrels_gain, as_scored_run(runs, use_rank_order=True))
        filled_d, _ = fill_missing_queries(final, query_ids_all, measures_flat)
        steps.append(("D  + 2^g-1 gain", filled_d, query_ids_all, len(filled_d)))

        mine_ndcg8 = mine["aggregate"]["ndcg"]["8"]
        out(f"    {'step':<28} {'nDCG@8':>10} {'vs metrics.js':>14} {'queries':>8}")
        for name, results, qids, n in steps:
            value = mean_over(results, qids, "ndcg_cut_8")
            out(f"    {name:<28} {value:10.6f} {mine_ndcg8 - value:+14.6f} "
                f"{len(results):8d}")
        out(f"    {'metrics.js (§9.1)':<28} {mine_ndcg8:10.6f} "
            f"{0.0:+14.6f} {mine['aggregate']['scored']:8d}")

        # ---- full comparison at step D ---------------------------------------
        theirs = filled_d
        out()
        out("  AGGREGATE, step D")
        out.rule()
        out(f"    {'metric':<16} {'metrics.js':>10} {'pytrec_eval':>12} "
            f"{'delta':>12}")
        agg_rows = compare_aggregates(mine, theirs, query_ids)
        agg_worst = 0.0
        for name, a, b, d in agg_rows:
            out(f"    {name:<16} {fmt(a)} {fmt(b):>12} {fmt_delta(d):>12}")
            agg_worst = max(agg_worst, abs(d))

        count, failures = compare_per_query(mine, theirs, query_ids)
        worst_d, worst_qid, worst_metric = max_abs_delta(mine, theirs, query_ids)

        out()
        out("  PER QUERY, step D")
        out.rule()
        out(f"    comparisons        {count:,}  "
            f"({len(query_ids):,} queries x 13 metrics)")
        out(f"    beyond {TOLERANCE:g}       {len(failures):,}")
        out(f"    max |delta|        {worst_d:.3e}"
            + (f"  at qid {worst_qid}, {worst_metric}" if worst_qid else ""))
        out(f"    max |delta| agg    {agg_worst:.3e}")

        passed = not failures and agg_worst <= TOLERANCE
        all_passed = all_passed and passed
        out()
        out(f"    RESULT             {'PASS' if passed else 'FAIL'}")

        if failures:
            out()
            out(f"    {'qid':<10} {'metric':<14} {'metrics.js':>12} "
                f"{'pytrec_eval':>12} {'delta':>12}")
            for qid, metric, a, b, d in failures[:20]:
                out(f"    {qid:<10} {metric:<14} {fmt(a):>12} {fmt(b):>12} "
                    f"{fmt_delta(d):>12}")
            if len(failures) > 20:
                out(f"    … {len(failures) - 20:,} more")
            # The worst single case, in full. A metric name and a delta say
            # something broke; the ranked list beside the grades says which
            # convention did.
            if worst_qid:
                out()
                out(f"    qid {worst_qid} in full:")
                judged = qrels.get(worst_qid, {})
                out(f"      judgments  " + "  ".join(
                    f"{d}={g}" for d, g in sorted(judged.items())))
                rows = runs.get(worst_qid, [])
                out(f"      returned   " + "  ".join(
                    f"{d}({r},{s:g}){'*' if d in judged else ''}"
                    for r, d, s in rows))
                out(f"      * = judged relevant")

        ladder_summary.append((label, passed, worst_d, agg_worst, count))

    bpref = measure_bpref(out, qrels, runs_by_label, query_ids_by_label)

    out()
    out("6. WHAT THIS DIFF DOES NOT ESTABLISH")
    out.rule()
    out("  A passing check is easy to over-read, so the gaps are named here")
    out("  rather than left for someone to assume were covered.")
    out()
    out("  - The unjudgeable-query branch of §9.1 is UNTESTED. metrics.js returns")
    out("    null and excludes those queries from the mean; cooking has 0 of them")
    out("    (build-qrels.js dropped the 74 out-of-corpus endpoints at 1.3), so no")
    out("    query in either run file exercises the path. It stays covered by unit")
    out("    test only until a corpus that has some appears.")
    out("  - MRR is validated as recip_rank@10, not as unbounded MRR. §2 above")
    out("    measures the gap the truncation hides.")
    out("  - Tie ordering is bridged, not reconciled. The run files' rank column")
    out("    is not recoverable from their score column, so a TREC tool reading")
    out("    one of these files without step C's transform scores a different")
    out("    ranking than this harness intends. Measured cost at nDCG@8 is small")
    out("    but non-zero; see step B->C in each ladder.")
    out("  - Only v1-overlap is covered, on dev only. Each later rung on the")
    out("    ladder needs its own run through this script — the check is of the")
    out("    scorer, but a new retriever can produce result shapes (longer lists,")
    out("    different tie density) that this pair does not exercise.")
    out()
    out("7. VERDICT")
    out.rule("=")
    for label, passed, worst_d, agg_worst, count in ladder_summary:
        out(f"  {label:<24} {'PASS' if passed else 'FAIL'}  "
            f"max|delta| {worst_d:.3e} over {count:,} per-query comparisons")
    out()
    if all_passed:
        out("  backend/eval/metrics.js agrees with pytrec_eval to within "
            f"{TOLERANCE:g} on every")
        out("  metric, at every k, for every query in both run files, once three")
        out("  differences are accounted for one at a time: the zero-result query")
        out("  population (§8.3), tie ordering (§7.2), and the gain formula (§9.1).")
        out("  The first two are properties of the harness that the reference")
        out("  cannot see; the third is a documented convention difference, not a")
        out("  defect in either implementation.")
    else:
        out("  DISAGREEMENT. Do not lift the provisional label. Work the smallest")
        out("  failing case by hand against §9.1: if hand-arithmetic gives")
        out("  pytrec_eval's number, metrics.js is wrong; if it gives ours, the")
        out("  spec differs from trec_eval's and the difference must be named.")

    out.write(OUT_FILE)
    print(f"\nwritten to {OUT_FILE.relative_to(REPO_ROOT)}", file=sys.stderr)
    return 0 if all_passed else 1


if __name__ == "__main__":
    sys.exit(main())
