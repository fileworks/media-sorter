#!/usr/bin/env python3
"""Evaluate local AI tagging and categorization on public, reviewed fixtures.

The manifest (``scripts/ai-eval/commons-manifest.json``) lists 640 px Wikimedia
Commons thumbnails with their licence, author, SHA-256 and reviewed labels. This
script downloads them into a cache outside the repository (verifying every
hash), embeds each image once with the installed SigLIP pack, and scores the
production tagger and categorizer against alternatives:

* ``production``: what ships (anchor-relative sigmoid for tags, softmax gate
  for categories), through the production code paths.
* ``native``: SigLIP's own pairwise sigmoid, ``sigmoid(scale·cos + bias)`` with
  the pinned checkpoint's learned ``logit_scale``/``logit_bias``, at several
  thresholds; scored against the pooled prompt vector and against the best
  single prompt.
* template sets (AI-10): the production ensemble, SigLIP's documented
  "This is a photo of {}." alone, and the ensemble without the article
  templates that produce "a photo of a pets".

Nothing is changed by running it; it prints a Markdown report and can write the
full numbers as JSON. Usage (from the repository root, with the backend venv)::

    backend/.venv/bin/python scripts/evaluate_local_ai.py \\
        --model-dir <installed model root> [--cache DIR] [--json report.json]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import ssl
import sys
import time
import urllib.request
from collections import Counter
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "backend"))

import numpy as np  # noqa: E402

MANIFEST = ROOT / "scripts" / "ai-eval" / "commons-manifest.json"
USER_AGENT = "MediaSorter-local-ai-evaluation/1.0 (+https://github.com/fileworks/media-sorter)"

#: google/siglip2-base-patch16-256 at revision 3f9f96cb90da5dbc758b01813f2f6f1aee24c1ab
#: (model.safetensors: logit_scale = 4.726513 → exp = 112.901, logit_bias = -16.771803).
NATIVE_SCALE = 112.90118
NATIVE_BIAS = -16.771803
NATIVE_THRESHOLDS = (0.001, 0.003, 0.01, 0.03, 0.1, 0.3)
MAX_TAGS = 10

SIGLIP_TEMPLATE = {
    "en": ("This is a photo of {}.",),
    "de": ("Dies ist ein Foto von {}.",),
}


# --------------------------------------------------------------------------- fixtures


def _ssl_context() -> ssl.SSLContext:
    try:
        import certifi

        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:  # pragma: no cover - certifi ships with the backend
        return ssl.create_default_context()


def fetch_fixtures(manifest: dict[str, Any], cache: Path) -> tuple[dict[str, Path], list[str]]:
    cache.mkdir(parents=True, exist_ok=True)
    context = _ssl_context()
    paths: dict[str, Path] = {}
    problems: list[str] = []
    for image in manifest["images"]:
        suffix = ".png" if image["url"].lower().endswith(".png") else ".jpg"
        target = cache / f"{image['sha256']}{suffix}"
        if not target.exists():
            try:
                request = urllib.request.Request(image["url"], headers={"User-Agent": USER_AGENT})
                with urllib.request.urlopen(request, timeout=90, context=context) as response:
                    data = response.read()
            except OSError as exc:
                problems.append(f"{image['id']}: download failed ({exc})")
                continue
            if hashlib.sha256(data).hexdigest() != image["sha256"]:
                problems.append(f"{image['id']}: SHA-256 mismatch; not used")
                continue
            target.write_bytes(data)
            time.sleep(0.2)
        elif hashlib.sha256(target.read_bytes()).hexdigest() != image["sha256"]:
            problems.append(f"{image['id']}: cached file changed; not used")
            continue
        paths[image["id"]] = target
    return paths, problems


# --------------------------------------------------------------------------- text side


def _templates_without_articles(locale: str) -> tuple[str, ...]:
    from app.services.ai.prompts import GERMAN_TEMPLATES, TEMPLATES

    if locale == "de":
        return GERMAN_TEMPLATES
    return tuple(t for t in TEMPLATES if t not in ("a photo of a {}", "a {}"))


def prompt_sets(label: str, locale: str, model_id: str, bundled: bool) -> dict[str, list[str]]:
    """Each template variant's prompts for one emitted label."""
    from app.core.concepts import CATALOG
    from app.services.ai import prompts

    production = prompts.prompt_group(
        label,
        operation_locale=locale,
        model_id=model_id,
        bundled=bundled,  # type: ignore[arg-type]
    )
    concept = CATALOG.resolve(label) if bundled else None
    prompt_label = concept.labels[locale] if concept is not None else label  # type: ignore[index]
    tail = production[-2:] if len(production) > len(_production_templates(locale)) else []
    no_articles = [t.format(prompt_label) for t in _templates_without_articles(locale)] + tail
    siglip = [t.format(prompt_label) for t in SIGLIP_TEMPLATE[locale]]
    return {"production": production, "no-articles": no_articles, "siglip-card": siglip}


def _production_templates(locale: str) -> tuple[str, ...]:
    from app.services.ai.prompts import GERMAN_TEMPLATES, TEMPLATES

    return GERMAN_TEMPLATES if locale == "de" else TEMPLATES


@dataclass
class Vocabulary:
    labels: list[str]
    pooled: dict[str, np.ndarray] = field(default_factory=dict)  # variant -> (L, D) unit rows
    best: dict[str, list[np.ndarray]] = field(default_factory=dict)  # variant -> per label (P, D)
    anchors: np.ndarray | None = None


def build_vocabulary(encoder: Any, labels: list[str], locale: str, bundled: bool) -> Vocabulary:
    from app.services.ai.prompts import anchor_prompts, pool_normalized

    vocab = Vocabulary(labels)
    variants: dict[str, list[list[str]]] = {}
    for label in labels:
        for variant, group in prompt_sets(label, locale, encoder.model_id, bundled).items():
            variants.setdefault(variant, []).append(group)
    for variant, groups in variants.items():
        flat = [prompt for group in groups for prompt in group]
        raw = np.asarray(encoder.embed_texts(flat), dtype=np.float32)
        vocab.pooled[variant] = pool_normalized(raw, [len(g) for g in groups])
        unit = raw / (np.linalg.norm(raw, axis=1, keepdims=True) + 1e-8)
        rows, start = [], 0
        for group in groups:
            rows.append(unit[start : start + len(group)])
            start += len(group)
        vocab.best[variant] = rows
    anchors = list(anchor_prompts(locale, encoder.model_id))  # type: ignore[arg-type]
    raw = np.asarray(encoder.embed_texts(anchors), dtype=np.float32)
    vocab.anchors = pool_normalized(raw, [1] * len(anchors))
    return vocab


# --------------------------------------------------------------------------- scoring


def _sigmoid(x: np.ndarray) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-x))


def production_tags(
    image: np.ndarray,
    vocab: Vocabulary,
    variant: str,
    slope: float,
    threshold: float,
    offset: float = 0.0,
) -> list[str]:
    """The anchor-relative sigmoid; ``offset`` 0 is the scoring before 2026-10-12."""
    assert vocab.anchors is not None
    sims = vocab.pooled[variant] @ image
    background = float((vocab.anchors @ image).max())
    probs = _sigmoid(slope * (sims - background - offset))
    order = np.argsort(-probs)
    return [vocab.labels[i] for i in order if probs[i] >= threshold][:MAX_TAGS]


def native_scores(image: np.ndarray, vocab: Vocabulary, variant: str, mode: str) -> np.ndarray:
    if mode == "pooled":
        cos = vocab.pooled[variant] @ image
    else:
        cos = np.asarray([float((rows @ image).max()) for rows in vocab.best[variant]])
    return _sigmoid(NATIVE_SCALE * cos + NATIVE_BIAS)


def _found(required: str, emitted: set[str]) -> bool:
    return any(option in emitted for option in required.split("|"))


@dataclass
class TagScore:
    required: int = 0
    found: int = 0
    emitted: int = 0
    false_positives: int = 0
    images_with_fp: int = 0
    images: int = 0
    fp_labels: Counter[str] = field(default_factory=Counter)

    def add(self, labels: list[str], acceptable: list[str], emitted: list[str]) -> None:
        allowed = {option for label in labels for option in label.split("|")} | set(acceptable)
        emitted_set = set(emitted)
        self.images += 1
        self.required += len(labels)
        self.found += sum(_found(label, emitted_set) for label in labels)
        self.emitted += len(emitted)
        wrong = [label for label in emitted if label not in allowed]
        self.false_positives += len(wrong)
        self.images_with_fp += bool(wrong)
        self.fp_labels.update(wrong)

    def row(self) -> dict[str, Any]:
        recall = self.found / self.required if self.required else 0.0
        precision = (self.emitted - self.false_positives) / self.emitted if self.emitted else 0.0
        f1 = 2 * recall * precision / (recall + precision) if recall + precision else 0.0
        return {
            "recall": round(recall, 3),
            "precision": round(precision, 3),
            "f1": round(f1, 3),
            "tags_per_image": round(self.emitted / max(1, self.images), 2),
            "images_with_false_positive": round(self.images_with_fp / max(1, self.images), 3),
            "top_false_positives": self.fp_labels.most_common(6),
        }


@dataclass
class CategoryScore:
    images: int = 0
    expected: int = 0
    correct: int = 0
    wrong: int = 0
    abstained_expected: int = 0
    assigned_unexpected: int = 0

    def add(self, expected: str | None, acceptable: list[str], predicted: str | None) -> None:
        self.images += 1
        if expected is not None:
            self.expected += 1
        if predicted is None:
            if expected is not None:
                self.abstained_expected += 1
            return
        if predicted == expected or predicted in acceptable:
            self.correct += 1
        else:
            self.wrong += 1
            if expected is None:
                self.assigned_unexpected += 1

    def row(self) -> dict[str, Any]:
        assigned = self.correct + self.wrong
        return {
            "coverage": round((self.expected - self.abstained_expected) / max(1, self.expected), 3),
            "accuracy_when_assigned": round(self.correct / assigned, 3) if assigned else None,
            "correct": self.correct,
            "wrong": self.wrong,
            "abstained_where_expected": self.abstained_expected,
        }


# --------------------------------------------------------------------------- run


def _evaluate_locale(
    locale: str,
    encoder: Any,
    images: list[dict[str, Any]],
    held_out: list[dict[str, Any]],
    embeddings: dict[str, np.ndarray],
    report: dict[str, Any],
) -> None:
    """Score one interface language; results go into *report*."""
    from app.core.concepts import CATALOG, bundled_labels
    from app.core.config import Config
    from app.services.ai.base_tagger import ZeroShotTagger
    from app.services.ai.category_classifier_service import (
        CategoryClassifierService,
        category_similarities,
    )

    config = Config(language=locale, ai_tagging_enabled=True, categorize_enabled=True)
    tag_labels = config.resolved_ai_tagging_labels()
    vocab = build_vocabulary(encoder, tag_labels, locale, bundled=True)
    to_en = {
        label: (CATALOG.resolve(label) or _Fallback(label)).labels["en"] for label in tag_labels
    }

    def score_tags(emit: Any, subset: list[dict[str, Any]] = images) -> dict[str, Any]:
        score = TagScore()
        for image in subset:
            vec = embeddings.get(image["id"])
            if vec is None:
                continue
            emitted = [to_en[label] for label in emit(vec)]
            score.add(image["labels"], image["acceptable"], emitted)
        return score.row()

    shipped_tagger = ZeroShotTagger(
        tag_labels,
        encoder,
        threshold=config.ai_tagging_confidence_threshold,
        locale=locale,
        bundled=True,
    )

    def shipped(vec: np.ndarray) -> list[str]:
        return [label for label, _ in shipped_tagger.tag_vector(vec)][:MAX_TAGS]

    def previous(vec: np.ndarray, variant: str = "production") -> list[str]:
        return production_tags(
            vec,
            vocab,
            variant,
            encoder.tagger_slope,
            config.ai_tagging_confidence_threshold,
        )

    results: dict[str, Any] = {
        "shipped": score_tags(shipped),
        "shipped — held-out half": score_tags(shipped, held_out),
        "before 2026-10-12": score_tags(previous),
        "before 2026-10-12 — held-out half": score_tags(previous, held_out),
    }
    for variant in ("no-articles", "siglip-card"):
        results[f"{variant} templates, previous scoring"] = score_tags(
            lambda v, variant=variant: previous(v, variant)
        )
    for variant in ("production", "no-articles", "siglip-card"):
        for mode in ("pooled", "best"):
            for threshold in NATIVE_THRESHOLDS:
                results[f"{variant} / native-{mode} ≥ {threshold}"] = score_tags(
                    lambda v, variant=variant, mode=mode, threshold=threshold: [
                        vocab.labels[i]
                        for i in np.argsort(-native_scores(v, vocab, variant, mode))
                        if native_scores(v, vocab, variant, mode)[i] >= threshold
                    ][:MAX_TAGS]
                )
    report["tagging"][locale] = results

    classifier = CategoryClassifierService(config, encoder)
    cats = classifier.categories()
    groups = classifier._prompt_groups(cats)
    assert groups is not None
    # Index-aligned bundled vocabularies: "Sport" (de) is the category "sports",
    # not the tag concept "sport" a free-text lookup would find.
    cat_en = dict(
        zip(bundled_labels("category", locale), bundled_labels("category", "en"), strict=True)
    )

    def score_categories(decide: Any, subset: list[dict[str, Any]] = images) -> dict[str, Any]:
        score = CategoryScore()
        for image in subset:
            vec = embeddings.get(image["id"])
            if vec is None:
                continue
            predicted = decide(vec)
            score.add(
                image["category"],
                image["acceptable_categories"],
                cat_en.get(predicted) if predicted else None,
            )
        return score.row()

    def shipped_category(vec: np.ndarray) -> str | None:
        return classifier._gate(category_similarities(groups, vec), cats).category

    category_results: dict[str, Any] = {
        "shipped": score_categories(shipped_category),
        "shipped — held-out half": score_categories(shipped_category, held_out),
        "before 2026-10-12": score_categories(
            lambda v: previous_category(v, encoder, config, cats, locale)
        ),
    }
    cat_vocab = build_vocabulary(encoder, cats, locale, bundled=True)
    for variant in ("production", "siglip-card"):
        for mode in ("pooled", "best"):
            for threshold in NATIVE_THRESHOLDS:
                category_results[f"{variant} / native-{mode} argmax ≥ {threshold}"] = (
                    score_categories(
                        lambda v, variant=variant, mode=mode, threshold=threshold: (
                            lambda probs: (
                                cats[int(np.argmax(probs))] if probs.max() >= threshold else None
                            )
                        )(native_scores(v, cat_vocab, variant, mode))
                    )
                )
    report["categorization"][locale] = category_results


def evaluate(model_dir: Path, cache: Path, json_out: Path | None) -> int:
    from app.services.ai.model_installation import AiModelStore
    from app.services.ai.siglip_encoder import SiglipOnnxEncoder
    from app.services.filesystem_service import open_image

    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    paths, problems = fetch_fixtures(manifest, cache)
    images = [image for image in manifest["images"] if image["id"] in paths]
    encoder = SiglipOnnxEncoder(model_store=AiModelStore(model_dir), allow_gpu=False)
    if not encoder.available:
        print("The SigLIP pack is not installed in", model_dir, file=sys.stderr)
        return 2

    embeddings: dict[str, np.ndarray] = {}
    started = time.perf_counter()
    for image in images:
        with open_image(paths[image["id"]]) as opened:
            raw = encoder.embed_image(opened) if opened is not None else None
        if raw is None:
            problems.append(f"{image['id']}: could not be embedded")
            continue
        vec = np.asarray(raw, dtype=np.float32).reshape(-1)
        embeddings[image["id"]] = vec / (np.linalg.norm(vec) + 1e-8)
    embed_seconds = time.perf_counter() - started

    # Parameters were chosen on the even-numbered half; the odd half is held out.
    held_out = [image for index, image in enumerate(images) if index % 2 == 1]
    report: dict[str, Any] = {
        "images": len(embeddings),
        "problems": problems,
        "embed_seconds": round(embed_seconds, 1),
        "tagging": {},
        "categorization": {},
    }
    for locale in ("en", "de"):
        _evaluate_locale(locale, encoder, images, held_out, embeddings, report)

    print(_markdown(report))
    if json_out is not None:
        json_out.write_text(json.dumps(report, indent=1, ensure_ascii=False), encoding="utf-8")
    return 0


def previous_category(
    vec: np.ndarray, encoder: Any, config: Any, cats: list[str], locale: str
) -> str | None:
    """The categorization before 2026-10-12: pooled prompts, anchors, temperature 60."""
    from app.services.ai.prompts import anchor_prompts, pool_normalized, prompt_group

    prompts: list[str] = []
    sizes: list[int] = []
    for name in cats:
        group = prompt_group(name, operation_locale=locale, model_id=encoder.model_id, bundled=True)
        prompts.extend(group)
        sizes.append(len(group))
    anchors = list(anchor_prompts(locale, encoder.model_id))
    raw = np.asarray(encoder.embed_texts(prompts + anchors), dtype=np.float32)
    cat_vecs = pool_normalized(raw[: len(prompts)], sizes)
    anchor_vecs = pool_normalized(raw[len(prompts) :], [1] * len(anchors))
    cat, anchor = cat_vecs @ vec, anchor_vecs @ vec
    logits = 60.0 * np.concatenate([cat, anchor])
    probs = np.exp(logits - logits.max())
    probs = probs / probs.sum()
    cat_probs = probs[: len(cats)]
    order = np.argsort(-cat_probs)
    top1, top2 = float(cat_probs[order[0]]), float(cat_probs[order[1]])
    if (
        float(cat[order[0]]) < float(anchor.max())
        or top1 < config.categorize_confidence_threshold
        or top1 - top2 < config.categorize_min_margin
    ):
        return None
    return cats[int(order[0])]


class _Fallback:
    def __init__(self, label: str) -> None:
        self.labels = {"en": label, "de": label}


def _markdown(report: dict[str, Any]) -> str:
    lines = [
        f"Images evaluated: {report['images']} (embedding took {report['embed_seconds']} s)",
        *(f"- {problem}" for problem in report["problems"]),
        "",
    ]
    for locale, results in report["tagging"].items():
        lines += [
            f"### Tagging — {locale}",
            "",
            "| Variant | Recall | Precision | F1 | Tags/image | Images with a false tag |",
            "|---|---|---|---|---|---|",
        ]
        fixed = [item for item in results.items() if item[0].startswith(("shipped", "before"))]
        ranked = sorted(
            (item for item in results.items() if item not in fixed),
            key=lambda item: -item[1]["f1"],
        )
        for name, row in fixed + ranked[:8]:
            lines.append(
                f"| {name} | {row['recall']} | {row['precision']} | {row['f1']} | "
                f"{row['tags_per_image']} | {row['images_with_false_positive']} |"
            )
        shipped = results["shipped"]
        lines += [
            "",
            f"Shipped scoring's most frequent false tags: {shipped['top_false_positives']}",
            "",
        ]
    for locale, results in report["categorization"].items():
        lines += [
            f"### Categorization — {locale}",
            "",
            "| Variant | Coverage | Accuracy when assigned | Correct | Wrong | Abstained |",
            "|---|---|---|---|---|---|",
        ]
        fixed = [item for item in results.items() if item[0].startswith(("shipped", "before"))]
        ranked = sorted(
            (item for item in results.items() if item not in fixed),
            key=lambda item: -(item[1]["correct"] - 3 * item[1]["wrong"]),
        )
        for name, row in fixed + ranked[:6]:
            lines.append(
                f"| {name} | {row['coverage']} | {row['accuracy_when_assigned']} | "
                f"{row['correct']} | {row['wrong']} | {row['abstained_where_expected']} |"
            )
        lines.append("")
    return "\n".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--model-dir", type=Path, default=os.environ.get("MEDIASORT_MODEL_DIR"))
    parser.add_argument(
        "--cache",
        type=Path,
        default=Path(os.environ.get("LOCALAPPDATA") or Path.home() / ".cache")
        / "MediaSorter"
        / "ai-eval",
    )
    parser.add_argument("--json", type=Path, default=None)
    args = parser.parse_args()
    if args.model_dir is None:
        parser.error("--model-dir (or MEDIASORT_MODEL_DIR) is required")
    return evaluate(args.model_dir, args.cache, args.json)


if __name__ == "__main__":
    raise SystemExit(main())
