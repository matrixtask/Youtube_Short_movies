# YouTube Shorts Studio — ローカル操作コマンド集
#
#   make setup        ローカル環境の一発構築（venv・依存・.env雛形）
#   make env-pull     .env を一括生成・検証（既存/ウィザード出力/GASから集める）
#   make gas-link     claspを既存のGASプロジェクトに紐づける（初回/再クローン後）
#   make gas-push     GASへコードを反映（clasp push）
#   make gas-deploy   GASへ反映 + Webアプリを再デプロイ（URLは変わらない）
#   make gas-open     GASエディタをブラウザで開く
#   make pull         Slackの新着動画を取り込んで処理（1回）
#   make watch        同上を常駐（5分間隔）
#   make run          workspace/inbox の動画を処理（手動モード）
#   make publish      投稿時刻が来た承認済みショートをYouTubeへ
#   make compile      Slack上のショートからまとめ動画を生成
#   make list         ショートのストック一覧
#   make gpu-check    GPUが使える状態か確認（文字起こしの高速化）
#   make test         パイプラインのテスト実行
#
# APIキー類は .env に書く（.env.example をコピー。gitには入らない）

-include .env
export

VENV := pipeline/.venv/bin

.PHONY: help setup env-pull gas-link gas-push gas-deploy gas-open pull watch run publish compile list gpu-check test

help:
	@grep -E '^#   make' Makefile | sed 's/^#   //'

setup:
	bash setup/local-setup.sh

env-pull:
	python3 setup/pull-env.py

gas-link:
	bash setup/gas-link.sh

gas-push:
	@[ -f gas/.clasp.json ] || { echo "✗ gas/.clasp.json がありません。先に make gas-link"; exit 1; }
	cd gas && clasp push -f

gas-deploy: gas-push
	bash setup/gas-deploy.sh

gas-open:
	cd gas && (clasp open-script 2>/dev/null || clasp open)

pull:
	cd pipeline && $(CURDIR)/$(VENV)/ytshorts pull

watch:
	cd pipeline && $(CURDIR)/$(VENV)/ytshorts pull --watch

run:
	cd pipeline && $(CURDIR)/$(VENV)/ytshorts run

publish:
	cd pipeline && $(CURDIR)/$(VENV)/ytshorts publish

compile:
	cd pipeline && $(CURDIR)/$(VENV)/ytshorts compile --from-slack

list:
	cd pipeline && $(CURDIR)/$(VENV)/ytshorts list

gpu-check:
	@cd pipeline && $(CURDIR)/$(VENV)/python -c "\
import ctranslate2 as c; \
from ytshorts.transcribe import resolve_device; \
n = c.get_cuda_device_count(); \
d, p = resolve_device('auto'); \
print(f'CTranslate2が見ているCUDAデバイス: {n}台'); \
print(f'実行時に選ばれるデバイス: {d} ({p})'); \
print('✅ GPUで動きます' if d == 'cuda' else '⚠ CPUで動きます（nvidia-smiでドライバを確認してください）')"

test:
	cd pipeline && $(CURDIR)/$(VENV)/python -m pytest tests/ -q
