# Imports, paths and settings shared by every part of the music worker.
import hashlib
import json
import os
import random
import re
import secrets
import shutil
import signal
import socket
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import unicodedata
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher

from app import (app, db, get_setting, get_numeric_setting, MUSIC_LIBRARY_PATH,
                 MusicJob, MusicArtist, MusicGenreRule, MusicSourceBudget, MusicAlbumMatch,
                 MusicWorker, MusicLike, MusicPlaylistSong)

WORKER_VERSION = '1.0.0'
USER_AGENT = f'ONEGY-Music/{WORKER_VERSION} ( https://{os.environ.get("DOMAIN", "localhost")} )'
WORKER_ID = f'{socket.gethostname()}:{os.getpid()}'
# Stable name in the admin Music tab; its per-worker toggles survive restarts.
WORKER_NAME = (os.environ.get('MUSIC_WORKER_NAME') or socket.gethostname())[:100]

LIB_DIR = MUSIC_LIBRARY_PATH
LIB_DB = os.path.join(LIB_DIR, 'library.db')
SONGS_DIR = os.path.join(LIB_DIR, 'songs')
COVERS_DIR = os.path.join(LIB_DIR, 'covers')
ARTISTS_DIR = os.path.join(LIB_DIR, 'artists')
TMP_DIR = os.path.join(LIB_DIR, 'tmp')

# Pool free-space floor: downloads pause below it (plan section 16).
MIN_FREE_FRACTION = 0.20
# Duration tolerance between the song card and a YouTube Music candidate / download.
# YouTube Music durations run 1-3 s longer than Deezer's whole seconds.
DURATION_TOLERANCE_S = 3
# Preview fingerprint: bit error rate below MATCH is the same recording; above
# REJECT is different audio; in between, the iTunes preview decides.
FP_MATCH_BER = 0.15
FP_REJECT_BER = 0.30
# Skipped outside the Everything mode: interludes and side-long pieces.
MIN_TRACK_S = 30
MAX_TRACK_S = 20 * 60
# Per-artist ceiling on songs one scan may queue; the rest wait for an admin rule.
ARTIST_SONG_CAP = 400

STOP = threading.Event()
# Status line per thread, shown in the admin Music tab by the heartbeat.
ACTIVITY = {}
# This worker's admin toggles and whether it is the one running discovery.
WORKER_FLAGS = {'discover': True, 'download': True, 'leader': False}


def set_activity(text):
    ACTIVITY[threading.current_thread().name] = text


def log(message):
    print(f'[MUSICD] {message}', flush=True)


def now():
    return datetime.now(timezone.utc)


def setting_on(key):
    with app.app_context():
        return bool(get_setting(key))


def setting_int(key):
    with app.app_context():
        return int(get_numeric_setting(key))
