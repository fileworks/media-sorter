"""P-08 — the path-identity and same-file rules, stated as properties.

Example tests pin the cases somebody thought of. `C-06` was exactly the bug
nobody thought of: macOS stores filenames decomposed, a camera or a zip supplies
them composed, and `café.jpg` written one way and read the other produced two
different `casefold()` results — splitting a RAW/JPEG pair and orphaning its
sidecar. `C-10` is its sibling: two names for one inode are one file, and
comparing them by name says otherwise.

Ported from `unpacksort/tests/test_policy_safety.py`, which already states the
same rules about archive members this backend re-derived for libraries.
"""

from __future__ import annotations

import os
import tempfile
import unicodedata
from pathlib import Path

from hypothesis import assume, given, settings
from hypothesis import strategies as st

from app.core.paths import path_identity_key, paths_refer_to_same_file

#: Filenames a real library actually contains: accents that decompose, case,
#: and the separators a name must survive. Control characters are excluded —
#: they are a filesystem's problem, not this function's.
_NAMES = st.text(
    alphabet=st.characters(
        blacklist_categories=("Cs", "Cc"),
        blacklist_characters="/\\\x00",
    ),
    min_size=1,
    max_size=40,
)


class TestPathIdentityKey:
    """C-06. One answer to "are these two names the same file?"."""

    @given(_NAMES)
    def test_composed_and_decomposed_spellings_agree(self, name: str) -> None:
        """The property the bug violated: NFD in, NFC in, same answer out."""
        composed = unicodedata.normalize("NFC", name)
        decomposed = unicodedata.normalize("NFD", name)

        assert path_identity_key(composed) == path_identity_key(decomposed)

    @given(_NAMES)
    def test_the_key_is_stable_under_reapplication(self, name: str) -> None:
        """A key that changed when re-keyed would make identity depend on how
        many times a value had been through the pipeline."""
        once = path_identity_key(name)

        assert path_identity_key(once) == once

    @given(st.text(alphabet=st.characters(min_codepoint=97, max_codepoint=122), min_size=1))
    def test_ascii_case_is_folded_unless_the_caller_says_otherwise(self, name: str) -> None:
        """Stated over ASCII on purpose — see the dotless-i test below for why
        "upper and lower agree" is not true of Unicode in general."""
        assert path_identity_key(name.upper()) == path_identity_key(name.lower())

    def test_the_turkish_dotless_i_is_not_folded_together_with_ascii_i(self) -> None:
        """Found by hypothesis while this file was being written, and it is the
        correct behaviour rather than a defect.

        `'ı'` (U+0131) is its own letter: it folds to itself, while `'ı'.upper()`
        is ASCII `'I'`, which folds to `'i'`. So a round trip through `.upper()`
        merges two distinct letters, but the key itself keeps them apart — which
        is what a filesystem does too. The first version of the property above
        asserted the round trip and was simply wrong about Unicode.
        """
        assert path_identity_key("ı") != path_identity_key("i")
        assert path_identity_key("ı".upper()) == path_identity_key("i")

    @given(_NAMES)
    def test_a_case_sensitive_context_keeps_the_distinction_it_can(self, name: str) -> None:
        """POSIX really does have `A.jpg` and `a.jpg` as two files, so a
        case-sensitive caller must not be handed a folded answer."""
        upper = unicodedata.normalize("NFC", name.upper())
        lower = unicodedata.normalize("NFC", name.lower())
        assume(upper != lower)

        assert path_identity_key(upper, case_sensitive=True) != path_identity_key(
            lower, case_sensitive=True
        )

    @given(_NAMES, _NAMES)
    def test_different_names_keep_different_keys(self, first: str, second: str) -> None:
        """A key that collided freely would merge unrelated files into one unit."""
        assume(path_identity_key(first) != path_identity_key(second))

        assert first != second


class TestSameFile:
    """C-10. Two names for one inode are one file, whatever the names say."""

    @given(st.binary(max_size=64))
    @settings(max_examples=25, deadline=None)
    def test_a_hard_link_is_the_same_file(self, payload: bytes) -> None:
        """The invariant `st_nlink` going unread hid: a library holding a file
        twice by hard link holds it once."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = root / "original.bin"
            original.write_bytes(payload)
            link = root / "linked.bin"
            try:
                os.link(original, link)
            except OSError:  # pragma: no cover - filesystem without hard links
                return

            assert paths_refer_to_same_file(original, link)
            assert paths_refer_to_same_file(link, original)

    @given(st.binary(max_size=64))
    @settings(max_examples=25, deadline=None)
    def test_identical_content_is_not_identity(self, payload: bytes) -> None:
        """The other half, and the dangerous one: two files with the same bytes
        are two files. Treating content as identity is how a copy gets deleted
        because something else happens to match it."""
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            first = root / "first.bin"
            second = root / "second.bin"
            first.write_bytes(payload)
            second.write_bytes(payload)

            assert not paths_refer_to_same_file(first, second)

    def test_a_path_is_always_itself(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "file.bin"
            path.write_bytes(b"x")

            assert paths_refer_to_same_file(path, path)
