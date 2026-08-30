# Music library drift inventory

Generated 2026-08-29 using a read-only scan of `/Users/louismollick/Music/liked-music-syncer` and `/home/ubuntu/louismollick-server/music` on `vps`.

## Counts

| Category | Files |
| --- | ---: |
| Local audio files | 1380 |
| VPS audio files | 1181 |
| VPS files present at the same local path | 1166 |
| VPS-only paths | 15 |
| VPS-only duplicate by embedded ID | 0 |
| VPS-only duplicate by normalized metadata and duration | 0 |
| VPS-only possible duplicate | 0 |
| VPS-only with no equivalent found | 15 |

The CSV contains every VPS `.m4a`, its classification, the best local match, and the evidence used. `possible` matches need human review. `no_equivalent_found` means no shared embedded identity and no artist/title/duration match under the documented thresholds.

## Diagnosis

The app does not run `rsync`. Normal sync and remote backfill use `rclone copyto`, which adds or overwrites one target and does not delete other paths. Reprocess has a targeted `rclone deletefile` cleanup when it knows the old path, but ordinary sync does not mirror the local tree.

The current remote-backfill path selection also preserves a stale remote path when it finds a song there by source or resolved YouTube ID. It then copies the current local file over that stale path. This explains both the drift and VPS files whose filename no longer describes their embedded title and artist.

There are 214 current local paths absent from the VPS. Of those, 0 are represented by an ID or metadata-matched file at another VPS path.

## VPS files with no canonical equivalent found

- `171/Soundproof Handle/01 グレモンハンドル - Soundproof Handle.m4a`
- `Anri/Timely!!/06 悲しみがとまらない I CAN'T STOP THE LONELINESS - Kanashimi ga Tomaranai I CAN'T STOP THE LONELINESS.m4a`
- `Akai Ko-En/Ko-en Debut/06 もんだな - Mondana.m4a`
- `Akai Ko-En/Ko-en Debut/03 つぶ - Tsubu.m4a`
- `Akai Ko-En/Ko-en Debut/07 急げ - Isoge.m4a`
- `Blume popo/apocalypsis/04 幸福のすべて - all of our happiness.m4a`
- `ASIAN KUNG-FU GENERATION/Landmark/07 それでは、また明日 - Well Then, See You Again Tomorrow.m4a`
- `BLUEGOATS/We are here/01 僕らはここだ - We are here.m4a`
- `-sokoninaru-そこに鳴る/_Singles/02 【ONE PIECE】きただにひろし『ウィーアー！』弾いてみた【そこに鳴る軽音部】.m4a`
- `-sokoninaru-そこに鳴る/_Singles/01 眩暈SIREN『偽物の宴』弾いてみた【そこに鳴る軽音部】Memaisiren - Nisemononoutage（cover）.m4a`
- `BiSH/プロミスザスター/01 プロミスザスター - promise the star.m4a`
- `Aooo/Fragile Night/01 フラジャイル・ナイト - Fragile Night.m4a`
- `CRAZY BLUES/light song/01 ライトソング - light song.m4a`
- `Aizora to Tsuki/Dying in You/01 僕は君の中で死んだ - Dying in You.m4a`
- `Monthly Shonen Irony/Unknown Album/436 少年 - Shonen.m4a`
