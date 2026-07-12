"""Shared CLIP prompt construction for AI tagging and Smart Categorization.

Zero-shot CLIP separates classes far better when each class is represented by an
*ensemble* of prompt templates averaged together (CLIP's standard zero-shot
trick), and — for categorisation — when well-known but visually-distinctive
topics carry a short descriptive phrase rather than a bare folder name. These
helpers centralise that prompt-building so the tagger and the categoriser stay
consistent.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

if TYPE_CHECKING:
    import numpy as np
    from numpy.typing import NDArray

# Prompt templates ensembled per label/category. Averaging the embeddings of
# several phrasings is markedly more robust than a single "a photo of {}".
TEMPLATES: tuple[str, ...] = (
    "a photo of {}",
    "a picture of {}",
    "an image of {}",
    "a high quality photo of {}",
    "a photograph of {}",
    "a photo of a {}",
    "a {}",
    "{}",
)

# Generic background / distractor prompts. These sit in the categoriser's
# softmax *denominator only* (never selectable as an output) so an
# out-of-vocabulary image sends its probability mass here instead of being
# forced into the least-wrong real category. Kept deliberately vague so they
# don't steal mass from a genuine category match.
ANCHOR_PROMPTS: tuple[str, ...] = (
    "a photo",
    "a random snapshot",
    "an ordinary picture",
    "a photo of an unrelated subject",
    "a nondescript image",
)

# Short descriptions for visually-distinctive topics whose bare folder name is a
# weak CLIP prompt. The *folder* keeps the user's chosen name; only the CLIP
# prompt is enriched. Keyed by the lower-cased category name.
#
# Coverage spans both the Smart-Categorization defaults *and* the default AI
# tagging vocabulary, so the same label gets a sharper, less ambiguous prompt in
# either feature. Each description names the concrete subject CLIP separates best
# on (a "sandy beach by the sea" beats a bare "beach").
DESCRIPTIONS: dict[str, str] = {
    # ── Document/screen types ──────────────────────────────────────────────────
    "screenshots": "a screenshot of a phone or computer screen",
    "screenshot": "a screenshot of a phone or computer screen",
    "receipts": "a paper receipt or printed invoice",
    "receipt": "a paper receipt or printed invoice",
    "documents": "a scanned document or sheet of paper with text",
    "document": "a scanned document or sheet of paper with text",
    "text": "a page or image dominated by written text",
    "graph": "a chart, graph or data visualization",
    "map": "a geographic map",
    "memes": "a meme image with overlaid caption text",
    "meme": "a meme image with overlaid caption text",
    "whiteboard": "a whiteboard or blackboard with handwriting",
    "artwork": "a drawing, painting or piece of artwork",
    "id": "an identity card or passport document",
    "ids": "an identity card or passport document",
    # ── People & events ─────────────────────────────────────────────────────────
    "portrait": "a close-up portrait photo of a person's face",
    "selfie": "a selfie or self-portrait photo taken at arm's length",
    "group photo": "multiple people posing together for a group photo",
    "people": "a photo of people or a person",
    "wedding": "a wedding ceremony with a bride and groom",
    "party": "people celebrating together at a party",
    "concert": "a live concert or music performance with a crowd",
    "sport": "people playing a sport or athletic activity",
    # ── Nature / environment ──────────────────────────────────────────────────
    "nature": "nature scenery with forests, mountains, rivers, or wildlife",
    "beach": "a sandy beach by the sea or ocean",
    "mountain": "a mountain or mountain range landscape",
    "forest": "a forest with many trees",
    "sky": "a wide open sky with clouds",
    "water": "a body of water such as a lake, river or sea",
    "snow": "a snowy winter landscape covered in snow",
    "flower": "a close-up of a flower or flowers",
    "sunset": "a colorful sunset or sunrise with orange and golden sky",
    "night": "a scene photographed at night or after dark",
    "indoor": "a photo taken inside a building or room",
    "outdoor": "a photo taken outdoors in nature or a city",
    "city": "a city skyline or downtown buildings",
    "building": "a large building or piece of architecture",
    "street": "a street or sidewalk with buildings and urban scenery",
    # ── Objects & vehicles ──────────────────────────────────────────────────────
    "car": "a car or automobile",
    "boat": "a boat or ship on water",
    "airplane": "an airplane or aircraft",
    # ── Food & animals ────────────────────────────────────────────────────────
    "food": "a plate of food or a prepared meal",
    "drink": "a beverage or drink in a cup or glass",
    "bird": "a bird",
    "dog": "a dog",
    "cat": "a cat",
    "pet": "a pet animal such as a dog or cat at home",
    "pets": "pets and animals at home such as dogs or cats",
    "wildlife": "wild animals in their natural habitat",
    # ── Travel & activities ────────────────────────────────────────────────────
    "travel": "a photo taken while travelling abroad or visiting a tourist destination",
    "events": "a social gathering, celebration or public event",
    "event": "a social gathering, celebration or public event",
    "sports": "people playing a sport or an athletic competition",
    "birthday": "a birthday celebration with cake or party decorations",
    "landmark": "a famous landmark, monument or tourist attraction",
    "monument": "a monument, statue or historic landmark",
    "hiking": "people hiking on a trail or walking in nature",
    "camping": "camping outdoors with tents or a campfire",
    "sunrise": "a colorful sunrise over the horizon",
}


def category_prompts(name: str) -> list[str]:
    """Ensembled prompts for a category folder, enriched with a description for
    well-known visually-distinctive topics. The folder name itself is unchanged —
    only the prompt the model scores against is enriched."""
    prompts = [t.format(name) for t in TEMPLATES]
    desc = DESCRIPTIONS.get(name.lower())
    if desc:
        prompts.append(desc)
        prompts.append(f"a photo of {desc}")
    return prompts


def pool_normalized(raw: NDArray[np.float32], sizes: list[int]) -> NDArray[np.float32]:
    """Average L2-normalised embeddings within each group and renormalise.

    *raw* is an ``(N, dim)`` matrix of un-normalised embeddings; *sizes* gives
    the number of consecutive prompts belonging to each group (summing to ``N``).
    Returns a ``(len(sizes), dim)`` matrix of unit vectors — one ensembled vector
    per group. Normalising before averaging keeps every phrasing's contribution
    equal regardless of its raw magnitude.
    """
    import numpy as np

    arr = np.asarray(raw, dtype=np.float32)
    norm = arr / (np.linalg.norm(arr, axis=1, keepdims=True) + 1e-8)
    out: list[NDArray[np.float32]] = []
    start = 0
    for size in sizes:
        chunk = norm[start : start + size]
        start += size
        vec = chunk.mean(axis=0)
        out.append(vec / (np.linalg.norm(vec) + 1e-8))
    return np.asarray(out, dtype=np.float32)
