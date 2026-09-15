#!/usr/bin/env python3
"""Drives a real Claude Code session in a pty to try the Doom board without a person: opens
/arcade doom, clicks the board, presses Enter through the menus, plays through the first room (walks, turns, fires, opens a
door, the automap, a run), cycles the drawing modes, waits for the idle pause, and saves what the emulated terminal shows (PNG and text) under $TMPDIR/cc-arcade-e2e,
then prints the plugin's lines from the debug log. Needs `pip install pyte` (a venv is fine) and a
logged-in Claude Code with function hooks. It answers the workspace-trust dialog with "Yes" for
this folder, which Claude Code then remembers.

    python3 scripts/e2e-doom.py [columns] [rows]
"""
import fcntl, json, os, pty, re, select, struct, sys, termios, time, zlib, urllib.request
import pyte

COLS, ROWS = int(sys.argv[1]) if len(sys.argv) > 1 else 160, int(sys.argv[2]) if len(sys.argv) > 2 else 60
REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(os.environ.get('TMPDIR', '/tmp'), 'cc-arcade-e2e'); os.makedirs(OUT, exist_ok=True)
LOG = os.path.join(OUT, 'e2e.log')

# make sure the plugin has to start the game server itself
try:
    urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:47321/quit', method='POST'), timeout=1).read()
    time.sleep(0.5)
except Exception:
    pass

env = dict(os.environ)
env.pop('CLAUDECODE', None); env.pop('CLAUDE_CODE_ENTRYPOINT', None)
env.update({'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS': '1', 'TERM': 'xterm-256color', 'COLORTERM': 'truecolor', 'LINES': str(ROWS), 'COLUMNS': str(COLS)})

pid, fd = pty.fork()
if pid == 0:
    os.chdir(REPO)
    os.execvpe('claude', ['claude', '--plugin-dir', '.', '--debug-file', LOG], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', ROWS, COLS, 0, 0))

screen = pyte.Screen(COLS, ROWS)
stream = pyte.ByteStream(screen)
raw = bytearray()

def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.05)
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                return False
            if not data:
                return False
            raw.extend(data)
            stream.feed(data)
    return True

def text():
    return '\n'.join(screen.display)

def wait_for(pattern, timeout, label):
    end = time.time() + timeout
    while time.time() < end:
        pump(0.3)
        if re.search(pattern, text()):
            print(f'[ok] {label}', flush=True)
            return True
        if 'trust this folder' in text() and 'Enter to confirm' in text():
            # the safe answer is first; the second is "Yes, I trust this folder"
            os.write(fd, b'\x1b[B'); pump(0.3); os.write(fd, b'\r'); print('[..] accepted the trust dialog', flush=True); pump(2)
    print(f'[!!] timeout waiting for {label}', flush=True)
    return False

def send(data, wait=0.15):
    os.write(fd, data if isinstance(data, bytes) else data.encode())
    pump(wait)

def find_board():
    """the row/col of the board: the line with the doom status text, the picture is above it"""
    for y, line in enumerate(screen.display):
        if 'doom ·' in line:
            return y
    return None

def shot(name):
    # every cell as a 2x4 block: half blocks and sextants from their glyph, anything else as its fg
    s = 4
    w, h = COLS * 2 * s // 2, ROWS * 4 * s // 4
    def rgb(c, default):
        if c == 'default': return default
        named = {'black': '000000', 'red': 'aa0000', 'green': '00aa00', 'brown': 'aa5500', 'blue': '0000aa', 'magenta': 'aa00aa', 'cyan': '00aaaa', 'white': 'aaaaaa',
                 'brightblack': '555555', 'brightred': 'ff5555', 'brightgreen': '55ff55', 'brightyellow': 'ffff55', 'brightblue': '5555ff', 'brightmagenta': 'ff55ff', 'brightcyan': '55ffff', 'brightwhite': 'ffffff'}
        if c in named: return bytes.fromhex(named[c])
        if re.fullmatch(r'[0-9a-fA-F]{6}', c): return bytes.fromhex(c)
        return default
    rows = []
    for y in range(ROWS):
        px = [[None] * (COLS * 2) for _ in range(4)]
        for x in range(COLS):
            ch = screen.buffer[y][x]
            fg, bg = rgb(ch.fg, b'\xd0\xd0\xd0'), rgb(ch.bg, b'\x10\x10\x10')
            g = ch.data
            if g == '▀': pat = [[fg, fg], [fg, fg], [bg, bg], [bg, bg]]
            elif g == '█': pat = [[fg, fg]] * 4
            elif g == '▌': pat = [[fg, bg]] * 4
            elif g == '▐': pat = [[bg, fg]] * 4
            elif g and 0x1fb00 <= ord(g[0]) <= 0x1fb3b:
                b = ord(g[0]) - 0x1fb00 + 1
                if b >= 21: b += 1
                if b >= 42: b += 1
                pat = [[fg if b & 1 else bg, fg if b & 2 else bg], [fg if b & 4 else bg, fg if b & 8 else bg], [fg if b & 16 else bg, fg if b & 32 else bg], [fg if b & 16 else bg, fg if b & 32 else bg]]
            elif g and g.strip(): pat = [[bg, bg], [fg, fg], [fg, fg], [bg, bg]]
            else: pat = [[bg, bg]] * 4
            for r in range(4):
                px[r][2 * x] = pat[r][0]; px[r][2 * x + 1] = pat[r][1]
        rows.extend(px)
    raw_png = b''
    for row in rows:
        line = b'\x00' + b''.join((c or b'\x10\x10\x10') * (s // 2) for c in row)
        raw_png += line * (s // 2)
    W, H = len(rows[0]) * (s // 2), len(rows) * (s // 2)
    def chunk(t, d): return struct.pack('>I', len(d)) + t + d + struct.pack('>I', zlib.crc32(t + d) & 0xffffffff)
    with open(os.path.join(OUT, f'{name}.png'), 'wb') as f:
        f.write(b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', W, H, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw_png)) + chunk(b'IEND', b''))
    with open(os.path.join(OUT, f'{name}.txt'), 'w') as f:
        f.write(text())
    print(f'[ok] screenshot {name}.png', flush=True)

try:
    if not wait_for(r'\? for shortcuts|Try "|bypass|/help', 40, 'prompt'):
        shot('e2e_noprompt'); raise SystemExit(1)
    pump(1.5)
    send('/arcade doom', 0.6)
    send('\r', 1.5)
    if not wait_for(r'doom ·', 25, 'doom board'):
        shot('e2e_noboard'); raise SystemExit(1)
    # the game server boots; then the picture arrives
    wait_for(r'doom · (click|paused|starting)', 20, 'status line')
    pump(4)
    shot('e2e_title')
    status_row = find_board()
    if status_row is None:
        raise SystemExit('no board')
    # click the middle of the picture (SGR mouse press and release, 1-based)
    row, col = status_row - 8, 30
    send(f'\x1b[<0;{col};{row + 1}M\x1b[<0;{col};{row + 1}m', 0.5)
    for _ in range(4):
        send('\r', 0.45)
    pump(1.5)
    shot('e2e_game')
    # play: forward through the first room, look around, fire, use, weapon keys, automap, a run
    def keys(seq, gap=0.09):
        for k in seq: send(k, gap)
    keys(['\x1b[A'] * 14); pump(0.4)
    keys(['\x1b[C'] * 8); pump(0.4)
    send(' ', 0.4); send(' ', 0.4)
    keys(['\x1b[A'] * 10); pump(0.3)
    shot('e2e_play1')
    keys(['\x1b[D'] * 6); send('e', 0.4); keys(['\x1b[A'] * 12); pump(0.4)
    send('\t', 1.0); shot('e2e_map'); send('\t', 0.4)
    send('2', 0.3); send(' ', 0.4)
    keys(['\x1b[1;2A'] * 10, 0.07); pump(0.3)
    keys(['\x1b[C'] * 12); pump(0.3)
    shot('e2e_play2')
    send('h', 1.2); shot('e2e_hires')
    keys(['\x1b[A'] * 8); keys(['\x1b[D'] * 6); pump(0.5)
    shot('e2e_hires2')
    send('h', 0.6)
    # idle: the game should pause by itself after ten seconds, then a key resumes it
    pump(11.5); shot('e2e_idle'); send('\x1b[A', 0.6)
    # back to the prompt and close
    send('\x1b', 0.5)
    send('/arcade stop', 0.5); send('\r', 1.0)
    shot('e2e_closed')
finally:
    try:
        send('/exit', 0.3); send('\r', 1.5)
    except OSError:
        pass
    try:
        os.kill(pid, 15)
    except ProcessLookupError:
        pass
    # what the plugin logged
    try:
        with open(LOG, errors='replace') as f:
            lines = [l.rstrip() for l in f if ('cc-arcade' in l or 'doom' in l.lower()) and not ('$.http.fetch' in l or 'ui.message' in l)]
        print('---- log ----')
        for l in lines[-40:]:
            print(l[:400])
    except FileNotFoundError:
        print('no log')
