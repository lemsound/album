#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
三文抒情 アルバムプレイヤー — マニフェスト生成スクリプト
==========================================================
曲やジャケット、歌詞ファイルを追加・削除・並べ替えたら、このスクリプトを
1回実行してください。フォルダの中身を読み取り、アプリが参照する
`manifest.json` を作り直します。

    python build.py          # このスクリプトと同じフォルダを対象にする
    python build.py ./music  # フォルダを指定したいとき

・「○○.album」というファイル名         → アルバム名
・「○○.artist」というファイル名        → アーティスト名（無ければ表示しない）
・曲順.txt                              → トラックの並び順（1行目=1曲目）
・「曲名.mp3」/「曲名.wav」             → 楽曲本体
・「曲名.txt」                          → その曲の歌詞
・「jacket.(jpg/jpeg/png)」             → アルバムジャケット
   （画像が1枚だけならそれをジャケットに採用）
・「曲名.(jpg/jpeg/png)」               → その曲のアイコン（リスト左に表示）

design.txt / timing.txt が無ければ、ひな形を自動生成します（既存は触りません）。
"""

import json
import os
import sys
import wave

IMAGE_EXTS = (".jpg", ".jpeg", ".png", ".webp")
AUDIO_EXTS = (".mp3", ".wav")


def read_lines(path):
    """改行コード(\\r\\n / \\n)や前後の空白を吸収して行リストを返す。"""
    with open(path, "r", encoding="utf-8-sig") as f:
        text = f.read()
    return [ln.strip() for ln in text.replace("\r\n", "\n").replace("\r", "\n").split("\n") if ln.strip()]


def audio_duration(path):
    """秒（float）を返す。読めなければ None。"""
    ext = os.path.splitext(path)[1].lower()
    try:
        if os.path.getsize(path) < 1024:        # 中身が空に近いファイルは未完成扱い
            return None
        if ext == ".wav":
            with wave.open(path, "rb") as w:
                frames = w.getnframes()
                rate = w.getframerate()
                return round(frames / float(rate), 3) if rate else None
        if ext == ".mp3":
            from mutagen.mp3 import MP3
            return round(float(MP3(path).info.length), 3)
    except Exception as e:
        print(f"  ! 長さを取得できませんでした: {os.path.basename(path)} ({e})")
        return None
    return None


def find_first(files_lower, basename, exts):
    """basename + 拡張子 のうち最初に見つかったファイル名(実体)を返す。"""
    for ext in exts:
        key = (basename + ext).lower()
        if key in files_lower:
            return files_lower[key]
    return None


def main():
    target = sys.argv[1] if len(sys.argv) > 1 else os.path.dirname(os.path.abspath(__file__))
    target = os.path.abspath(target)
    print(f"対象フォルダ: {target}\n")

    entries = [e for e in os.listdir(target) if os.path.isfile(os.path.join(target, e))]
    files_lower = {e.lower(): e for e in entries}   # 小文字キー → 実ファイル名

    # --- アルバム名 / アーティスト名 ---
    album = None
    artist = None
    for e in entries:
        low = e.lower()
        if low.endswith(".album"):
            album = os.path.splitext(e)[0]
        elif low.endswith(".artist"):
            artist = os.path.splitext(e)[0]
    if not album:
        album = os.path.basename(target)
        print("※ .album ファイルが無いので、フォルダ名をアルバム名にしました。")
    print(f"アルバム名 : {album}")
    print(f"アーティスト: {artist or '（指定なし）'}")

    # --- 曲順 ---
    order_path = os.path.join(target, "曲順.txt")
    if os.path.exists(order_path):
        order = read_lines(order_path)
    else:
        order = [os.path.splitext(f)[0] for f in entries if f.lower().endswith(AUDIO_EXTS)]
        print("※ 曲順.txt が無いので、見つかった順に並べました。")

    # --- ジャケット ---
    jacket = find_first(files_lower, "jacket", IMAGE_EXTS)
    if not jacket:
        imgs = [e for e in entries if e.lower().endswith(IMAGE_EXTS)]
        song_names = set(order)
        loose = [i for i in imgs if os.path.splitext(i)[0] not in song_names]
        if len(loose) == 1:                      # 画像が1枚だけならジャケット採用
            jacket = loose[0]
    print(f"ジャケット : {jacket or '（なし）'}\n")

    # --- トラック ---
    tracks = []
    total = 0.0
    for i, name in enumerate(order, 1):
        audio = find_first(files_lower, name, AUDIO_EXTS)
        if not audio:
            print(f"[{i:>2}] {name}  … 音源が見つかりません（スキップ）")
            continue
        lyrics = find_first(files_lower, name, (".txt",))
        image = find_first(files_lower, name, IMAGE_EXTS)
        dur = audio_duration(os.path.join(target, audio))
        if dur:
            total += dur
        tracks.append({
            "name": name,
            "audio": audio,
            "type": os.path.splitext(audio)[1].lstrip(".").lower(),
            "lyrics": lyrics,
            "image": image if (image and image.lower() != (jacket or "").lower()) else None,
            "duration": dur,
        })
        mm = "--:--" if dur is None else f"{int(dur)//60}:{int(dur)%60:02d}"
        print(f"[{i:>2}] {name:<16} {mm}"
              f"{'  歌詞○' if lyrics else '  歌詞×'}"
              f"{'  画像○' if image and image.lower()!=(jacket or '').lower() else ''}")

    manifest = {
        "album": album,
        "artist": artist,
        "jacket": jacket,
        "totalDuration": round(total, 3),
        "tracks": tracks,
    }
    out = os.path.join(target, "manifest.json")
    with open(out, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    mm = f"{int(total)//60}分{int(total)%60}秒"
    print(f"\n合計時間 : {mm}（未測定の曲を除く）")
    print(f"書き出し : {out}")

    # --- design.txt / timing.txt のひな形（無いときだけ作る）---
    scaffold_design(target)
    scaffold_timing(target, order)


def scaffold_design(target):
    path = os.path.join(target, "design.txt")
    if os.path.exists(path):
        return
    with open(path, "w", encoding="utf-8") as f:
        f.write(DESIGN_TEMPLATE)
    print("design.txt を新規作成しました。")


def scaffold_timing(target, order):
    path = os.path.join(target, "timing.txt")
    if os.path.exists(path):
        return
    lines = [TIMING_HEADER]
    for name in order:
        lines.append(f"{name}\t頭=+0.0\t尻=+0.0")
    with open(path, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print("timing.txt を新規作成しました（全曲0秒）。")


DESIGN_TEMPLATE = """\
# ============================================================
#  三文抒情 — デザイン設定ファイル
#  「=」の右側だけ書き換えれば見た目が変わります。
#  行頭が # の行はコメント（無視されます）。保存して再読み込みすればOK。
# ============================================================

# --- アルバム情報 ---
リリース年 = 2026

# --- 色（カラーコードで指定。先頭の # は色コードの記号なので消さないこと）---
背景色   = #000000
サブ色   = #161616
差し色   = #e8c45a
文字色   = #f2f2f2
淡色     = #8c8c8c

# --- フォント ---
# 使える値: 明朝 / ゴシック / セリフ / サンセリフ
アルバム名 = 明朝
歌詞       = 明朝

# --- 曲ごとに歌詞フォントを変えたいときだけ（任意）---
# 「歌詞@曲名 = フォント」の形式で下に追記してください。
# 例) 歌詞@天井 = ゴシック
"""

TIMING_HEADER = """\
# ============================================================
#  三文抒情 — 曲の頭/尻 微調整ファイル（単位：秒）
#   ・プラス(+) … その分だけ無音を足す
#   ・マイナス(-) … その分だけカットする
#   例)  天井  頭=+0.0  尻=+0.3   → 曲尻に0.3秒の無音を追加
#   例)  灰色  頭=-0.5  尻=+0.0   → 曲頭を0.5秒カット
#  曲名のあとは半角スペースかタブで区切ってください。
# ============================================================"""


if __name__ == "__main__":
    main()
