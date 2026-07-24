"""Validated bundled English/German concepts for generated content."""

from __future__ import annotations

import json
from dataclasses import dataclass
from importlib.resources import files
from typing import Literal

from app.core.rules import normalized_key

Locale = Literal["en", "de"]
VocabularyKind = Literal["tag", "category"]


@dataclass(frozen=True)
class Concept:
    id: str
    kinds: frozenset[VocabularyKind]
    labels: dict[Locale, str]
    aliases: tuple[str, ...]
    prompts: dict[Locale, str]


class ConceptCatalog:
    def __init__(self, concepts: tuple[Concept, ...]) -> None:
        self.concepts = concepts
        self._by_id = {concept.id: concept for concept in concepts}
        self._alias: dict[str, Concept] = {}
        for concept in concepts:
            for raw in [concept.id, *concept.labels.values(), *concept.aliases]:
                key = normalized_key(raw)
                previous = self._alias.get(key)
                if (
                    previous is not None
                    and previous.id != concept.id
                    and previous.labels != concept.labels
                    and not previous.kinds.isdisjoint(concept.kinds)
                ):
                    raise ValueError(f"duplicate concept alias: {raw!r}")
                self._alias.setdefault(key, concept)

    def labels(self, kind: VocabularyKind, locale: Locale) -> list[str]:
        concepts = [concept for concept in self.concepts if kind in concept.kinds]
        if kind == "category":
            order = {
                concept_id: index
                for index, concept_id in enumerate(
                    (
                        "screenshots",
                        "documents",
                        "receipts",
                        "food",
                        "nature",
                        "people",
                        "pets",
                        "travel",
                        "events",
                        "sports",
                        "memes",
                    )
                )
            }
            concepts.sort(key=lambda concept: order[concept.id])
        return [concept.labels[locale] for concept in concepts]

    def resolve(self, value: str) -> Concept | None:
        return self._alias.get(normalized_key(value))

    def localized_label(self, value: str, locale: Locale) -> str | None:
        concept = self.resolve(value)
        return concept.labels[locale] if concept is not None else None

    def prompt(self, concept: Concept, locale: Locale) -> str:
        return concept.prompts[locale]


def load_catalog() -> ConceptCatalog:
    resource = files("app.resources").joinpath("concepts.json")
    raw = json.loads(resource.read_text(encoding="utf-8"))
    if raw.get("version") != 1 or not isinstance(raw.get("concepts"), list):
        raise ValueError("unsupported bundled concept resource")
    concepts: list[Concept] = []
    ids: set[str] = set()
    labels_by_locale_kind: dict[tuple[str, str], set[str]] = {
        (locale, kind): set() for locale in ("en", "de") for kind in ("tag", "category")
    }
    for item in raw["concepts"]:
        concept_id = str(item["id"])
        if concept_id in ids:
            raise ValueError(f"duplicate concept id: {concept_id}")
        ids.add(concept_id)
        kinds = frozenset(item["kinds"])
        if not kinds or not kinds <= {"tag", "category"}:
            raise ValueError(f"invalid kinds for concept: {concept_id}")
        labels = {"en": str(item["labels"]["en"]).strip(), "de": str(item["labels"]["de"]).strip()}
        prompts = {
            "en": str(item["prompts"]["en"]).strip(),
            "de": str(item["prompts"]["de"]).strip(),
        }
        if not all([*labels.values(), *prompts.values()]):
            raise ValueError(f"incomplete concept: {concept_id}")
        for locale, label in labels.items():
            key = normalized_key(label)
            for kind in kinds:
                seen = labels_by_locale_kind[(locale, kind)]
                if key in seen:
                    raise ValueError(f"duplicate {locale} {kind} concept label: {label}")
                seen.add(key)
        concepts.append(
            Concept(
                id=concept_id,
                kinds=frozenset(kinds),
                labels=labels,  # type: ignore[arg-type]
                aliases=tuple(str(value) for value in item.get("aliases", [])),
                prompts=prompts,  # type: ignore[arg-type]
            )
        )
    return ConceptCatalog(tuple(concepts))


CATALOG = load_catalog()


def bundled_labels(kind: VocabularyKind, locale: Locale) -> list[str]:
    return CATALOG.labels(kind, locale)
