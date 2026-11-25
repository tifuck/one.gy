#!/usr/bin/env python3
"""ONE.GY music worker: discovers, downloads, verifies and publishes songs to the
music library (MUSIC_LIBRARY_PATH). Design: docs/music-pipeline-plan.md.

The code lives in src/music_worker/ and is executed here, in order, into this
module's namespace (like app.py and src/app/). It imports the app for its
database, models and settings, so it uses the same .env as the app beside it.

Usage:
  music_worker.py run              coordinator + local worker (the systemd service)
  music_worker.py status           queue, roster and library counts
  music_worker.py roster           rebuild the artist roster now
  music_worker.py sync-artist ID   scan one Deezer artist and queue its songs
  music_worker.py acquire ID       download and publish one Deezer track now

Discovery and downloads only run while the admin settings
music_discovery_enabled / music_downloads_enabled are on; `run` checks them
every minute.
"""


def _load_parts():
    import os
    here = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'src', 'music_worker')
    for name in (
        '010_config.py',
        '020_http.py',
        '030_sources.py',
        '035_youtube.py',
        '040_normalize.py',
        '050_library.py',
        '060_identity.py',
        '070_jobs.py',
        '080_discovery.py',
        '090_acquire.py',
        '100_runner.py',
    ):
        path = os.path.join(here, name)
        with open(path, encoding='utf-8') as fp:
            source = fp.read()
        exec(compile(source, path, 'exec'), globals())


_load_parts()
del _load_parts

if __name__ == '__main__':
    main()
