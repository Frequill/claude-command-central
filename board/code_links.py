"""Where the code Claude names in its replies is, so the board can open it in the person's editor.

Claude writes files, classes and methods as code chips: `AbstractDuoNode.java`, `releasePushCall`,
`pushCall.getPushSuccess()`. A chip that names a file of the session's folder points at that file. Any
other chip that is a name points at the places that name is made (a class, a method, a constant), found
with `git grep`, not at the places it is only used. A chip that points nowhere, or at too many places
to choose from, gets no link.

The board names only the session and the chip; the server takes the folder from the session's own
transcript, so a page can never search a folder of its own choosing.
"""

import os
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor

# a chip that points at more places than this gets no link: a list that long helps nobody
MOST_PLACES = 8
# the most chips one reply asks about, and the longest chip looked at
MOST_CHIPS = 200
LONGEST_CHIP = 300
# a name shorter than this is too common to look for (`id`, `ok`)
SHORTEST_NAME = 3
# lines longer than this are generated code or data, never where a name is made
LONGEST_LINE = 400
# how much of git grep's answer is read; a name used this much is too common anyway
MOST_GREP_BYTES = 8_000_000
# a folder that is no repository but holds some (a folder of projects): the most of them searched,
# and how many at once
MOST_REPOSITORIES = 64
SEARCHES_AT_ONCE = 8

# a file's name or path, with a line after it or not: `a/b.py`, `B.java:61`, `/abs/c.ts:4:2`
FILE_CHIP = re.compile(r"^(?P<path>[\w./@+-]*[\w-]\.[A-Za-z0-9]{1,10}|[\w./@+-]+/[\w.@+-]+)(?::(?P<line>\d{1,7}))?(?::\d{1,5})?$")
# a name, maybe inside a longer one and with a call after it: `foo`, `Foo#bar`, `a.b.c()`, `Foo::bar(x)`
NAME_CHIP = re.compile(r"^@?[A-Za-z_$][\w$]*(?:(?:\.|#|::)[A-Za-z_$][\w$]*)*(?:\([^()]{0,120}\))?$")
IDENTIFIER = re.compile(r"[A-Za-z_$][\w$]*")
FILE_KINDS = re.compile(r"\.(?:java|kt|kts|py|js|mjs|cjs|ts|tsx|jsx|go|rs|rb|php|cs|swift|c|h|cpp|hpp|m|scala|groovy|sh|zsh|sql|md|json|ya?ml|toml|xml|html|css|scss|less|gradle|properties|txt|cfg|ini|conf|vue|svelte|proto|tf|lock|env)$", re.I)
# words that are a language's own, never a name someone made
KEYWORDS = {
    "null", "true", "false", "none", "None", "True", "False", "undefined", "this", "self", "super", "return",
    "new", "class", "public", "private", "protected", "static", "final", "void", "async", "await", "const",
    "let", "var", "function", "def", "import", "export", "from", "string", "String", "int", "long", "boolean",
}
CALL_WORDS = r"(?:return|new|throw|else|if|while|for|switch|case|await|yield|assert|catch|when|do|try|elif|not|and|or|in|is|print|echo)"
MODIFIERS = r"(?:(?:public|private|protected|internal|static|final|abstract|synchronized|native|default|override|open|async|export|suspend|inline|operator|infix|readonly|declare|transient|volatile|const|lateinit|data|sealed|pub(?:\([\w ]+\))?|unsafe|extern)\s+)"


def definitions(name: str) -> list:
    """The ways a line makes the name, in the languages the person is likely to write."""
    n = re.escape(name)
    shapes = [
        # a class, interface, type and the like
        rf"\b(?:class|interface|enum|record|object|trait|struct|type|typealias|module|protocol|namespace|annotation)\s+{n}\b",
        # a function with a word that says so
        rf"\b(?:def|fun|func|function|fn|sub|method)\s+(?:\([^)]*\)\s*)?(?:[\w.<>]+\.)?{n}\s*[(<\[]",
        # a variable or constant with a word that says so
        rf"\b(?:val|var|let|const)\s+{n}\b",
        # Java, C#, C++ and Kotlin methods with a type before them; not a call, which ends in ";"
        rf"^\s*{MODIFIERS}*(?:<[^>]*>\s*)?(?!{CALL_WORDS}\b)[\w$<>\[\],.?]+(?:<[^;=]*>)?\s+{n}\s*\([^;]*$",
        # an interface's or abstract method, `void releasePushCall(PushCall call);`
        rf"^\s*{MODIFIERS}*(?:<[^>]*>\s*)?(?!{CALL_WORDS}\b)[\w$<>\[\],.?]+\s+{n}\s*\([^)]*\)\s*(?:throws\s+[\w., ]+)?;",
        # methods with no type before them (JavaScript, TypeScript, Python's class bodies): a body follows
        rf"^\s*{MODIFIERS}*(?:get\s+|set\s+|static\s+|\*\s*)?{n}\s*(?:<[^>]*>)?\s*\([^;]*\)\s*(?::\s*[^=;]+)?\s*\{{",
        # fields and constants with a type before them
        rf"^\s*{MODIFIERS}+[\w$<>\[\],.?]+\s+{n}\s*(?:=|;)",
        # an object's or a class's field that holds a function: `foo: () =>`, `foo = async (`
        rf"^\s*{MODIFIERS}*{n}\s*[:=]\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::\s*[^=]+)?=>|\w+\s*=>)",
        # Python and shell: a module's constant, `NAME = 1`, at the start of a line
        rf"^{n}\s*(?::\s*[\w\[\], .]+)?=(?!=)",
    ]
    # an enum's value, `SESSION_END,` or `SESSION_END("end"),`: only for names in capitals
    if name.isupper() or re.fullmatch(r"[A-Z][A-Z0-9_]+", name):
        shapes.append(rf"^\s*{n}\s*(?:\([^;]*\))?\s*(?:\{{|,|;)?\s*(?://.*)?$")
    return [re.compile(shape) for shape in shapes]


def kind_of(chip: str):
    """('file', path, line) for a chip that names a file, ('name', name, None) for one that names code,
    or None for one that is neither (`!= null`, `SESSION_END and`, a sentence)."""
    chip = chip.strip().strip("`").strip()
    # spaces only inside a call's brackets: `foo(a, b)` is a name, `x != null` is not
    if not chip or len(chip) > LONGEST_CHIP or any(c.isspace() for c in re.sub(r"\([^()]*\)$", "", chip)):
        return None
    found = FILE_CHIP.match(chip)
    # `a.b` can be a file or a field: with no folder in it, only a file kind people write code in is a file
    if found and ("/" in chip or FILE_KINDS.search(found.group("path"))):
        return ("file", found.group("path"), int(found.group("line") or 0) or None)
    if NAME_CHIP.match(chip):
        bare = chip.split("(", 1)[0]
        name = IDENTIFIER.findall(bare)[-1]
        if len(name) < SHORTEST_NAME or name in KEYWORDS:
            return None
        # a plain word (`grep`, `run`, `vmx.inbox.any`) is a word or a key, unless it is called: `run()`
        if is_plain_word(name) and not chip.endswith(")"):
            return None
        return ("name", name, None)
    return None


def is_plain_word(name: str) -> bool:
    """A name with only small letters, as a word of English is: likely made in many places."""
    return name.isalpha() and name.islower()


# where tests are: a name made in a test and in the code itself means the code
TEST_PATH = re.compile(r"(?:^|/)(?:tests?|__tests__|spec|testing)/|(?:^|/)test_[^/]+$|_test\.\w+$|[Tt]est[s]?\.\w+$|\.(?:test|spec)\.\w+$|Spec\.\w+$")


def without_tests(places: list) -> list:
    """The places that are not in tests, when there are any; else all of them."""
    real = [place for place in places if not TEST_PATH.search(place["path"])]
    return real or places


def file_places(folder: str, path: str, line, files: list) -> list:
    """The files of the folder that a chip naming a file points at: the path itself, or files whose
    path ends in it."""
    if path.startswith("/"):
        inside = os.path.realpath(path)
        root = os.path.realpath(folder)
        if inside.startswith(root + os.sep) and os.path.isfile(inside):
            return [{"path": os.path.relpath(inside, root), "line": line or 1}]
        return []
    path = path.removeprefix("./")
    if path in files:
        return [{"path": path, "line": line or 1}]
    tail = "/" + path
    return [{"path": name, "line": line or 1} for name in files if name.endswith(tail)][: MOST_PLACES + 1]


def grep_lines(folder: str, names: list, run=subprocess.run):
    """git grep's lines that hold any of the names as a whole word, as (path, line, text); None
    outside a repository."""
    if not names:
        return []
    command = ["git", "-C", folder, "grep", "-n", "-I", "-w", "-F", "--untracked", "--no-color", "--full-name"]
    for name in names:
        command += ["-e", name]
    try:
        done = run(command, capture_output=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    # 1 is "nothing found"; anything above it is git saying this is no repository
    if done.returncode > 1:
        return None
    found = []
    for raw in done.stdout[:MOST_GREP_BYTES].decode("utf-8", errors="replace").splitlines():
        path, _, rest = raw.partition(":")
        number, _, text = rest.partition(":")
        if number.isdigit() and len(text) <= LONGEST_LINE:
            found.append((path, int(number), text))
    return found


def git_root(folder: str, run=subprocess.run):
    try:
        done = run(["git", "-C", folder, "rev-parse", "--show-toplevel"], capture_output=True, text=True, timeout=5)
    except (OSError, subprocess.SubprocessError):
        return None
    return done.stdout.strip() if done.returncode == 0 and done.stdout.strip() else None


def field_of(name: str):
    """The field a getter or setter reads, for code that makes them for it (Lombok): `getPushSuccess`
    is `pushSuccess`, `isDone` is `done`. None for any other name."""
    found = re.fullmatch(r"(?:get|set|is)([A-Z])(\w*)", name)
    return found.group(1).lower() + found.group(2) if found else None


def name_places(folder: str, names: list, run=subprocess.run) -> dict:
    """For each name, the places in the folder's repository where it is made. A class's own line
    stands for it, not its constructors too. A getter or setter no file writes out is found at its field."""
    fields = {name: field_of(name) for name in names}
    looked = sorted(set(names) | {field for field in fields.values() if field})
    # a plain word is in so many lines that it gets a search of its own: it can never crowd out the rest
    groups = [[name for name in looked if not is_plain_word(name)]] + [[name] for name in looked if is_plain_word(name)]
    lines = []
    for group in groups:
        lines += (grep_lines(folder, group, run) or []) if group else []
    if not lines:
        return {}
    root = git_root(folder, run) or folder
    shapes = {name: definitions(name) for name in looked}
    classes = {name: re.compile(rf"\b(?:class|interface|enum|record|object|trait|struct|protocol|annotation)\s+{re.escape(name)}\b") for name in looked}
    held = {name: re.compile(rf"\b{re.escape(name)}\s*(?:=|;)") for name in looked}
    made, made_classes, made_fields = {}, {}, {}
    for path, number, text in lines:
        for name in looked:
            if name in text and any(shape.search(text) for shape in shapes[name]):
                place = {"path": os.path.relpath(os.path.join(root, path), folder), "line": number}
                made.setdefault(name, []).append(place)
                if classes[name].search(text):
                    made_classes.setdefault(name, []).append(place)
                if held[name].search(text):
                    made_fields.setdefault(name, []).append(place)
    places = {}
    for name in names:
        found = made_classes.get(name) or made.get(name) or (made_fields.get(fields[name]) if fields[name] else None)
        if found:
            places[name] = found
    return places


def repositories(folder: str, run=subprocess.run) -> list:
    """The repositories a folder's code is in, each with what goes before its paths: the folder's own,
    or, for a folder of projects that is none, each project in it that is one."""
    if git_root(folder, run):
        return [(folder, "")]
    try:
        entries = sorted(os.scandir(folder), key=lambda entry: entry.name)
    except OSError:
        return []
    found = [(entry.path, entry.name + "/") for entry in entries if entry.is_dir() and not entry.name.startswith(".") and os.path.exists(os.path.join(entry.path, ".git"))]
    return found[:MOST_REPOSITORIES]


def places_for(folder: str, chips: list, files_of, run=subprocess.run) -> dict:
    """For each chip that points somewhere, the places it points at, each a path in the folder and a
    line; chips that point nowhere, or at more than MOST_PLACES places, are left out. `files_of(folder)`
    gives a folder's files, relative to it."""
    kinds = {}
    for chip in chips[:MOST_CHIPS]:
        if isinstance(chip, str) and chip not in kinds:
            kind = kind_of(chip)
            if kind:
                kinds[chip] = kind
    if not kinds:
        return {}
    repos = repositories(folder, run)
    names = sorted({kind[1] for kind in kinds.values() if kind[0] == "name"})
    made = {}
    if names and repos:
        with ThreadPoolExecutor(SEARCHES_AT_ONCE) as pool:
            for (repo, before), places in zip(repos, pool.map(lambda found: name_places(found[0], names, run), repos)):
                for name, list_of in places.items():
                    made.setdefault(name, []).extend({"path": before + place["path"], "line": place["line"]} for place in list_of)
    files = None
    if any(kind[0] == "file" for kind in kinds.values()):
        nested = repos and repos != [(folder, "")]
        files = [before + name for repo, before in repos for name in files_of(repo)] if nested else files_of(folder)
    found = {}
    for chip, (kind, what, line) in kinds.items():
        places = file_places(folder, what, line, files) if kind == "file" else without_tests(made.get(what, []))
        if 0 < len(places) <= MOST_PLACES:
            found[chip] = places
    return found
