# YouTube Shorts Studio — ローカル操作コマンド集
#
#   make setup        ローカル環境の一発構築（venv・依存・.env雛形）
#   make gas-push     GASへコードを反映（clasp push）
#   make gas-deploy   GASへ反映 + Webアプリを再デプロイ（URLは変わらない）
#   make gas-open     GASエディタをブラウザで開く
#   make pull         Slackの新着動画を取り込んで処理（1回）
#   make watch        同上を常駐（5分間隔）
#   make run          workspace/inbox の動画を処理（手動モード）
#   make publish      投稿時刻が来た承認済みショートをYouTubeへ
#   make compile      Slack上のショートからまとめ動画を生成
#   make list         ショートのストック一覧
#   make test         パイプラインのテスト実行
#
# APIキー類は .env に書く（.env.example をコピー。gitには入らない）

-include .env
export

VENV := pipeline/.venv/bin

.PHONY: help setup gas-push gas-deploy gas-open pull watch run publish compile list test

help:
	@grep -E '^#   make' Makefile | sed 's/^#   //'

setup:
	bash setup/local-setup.sh

gas-push:
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

test:
	cd pipeline && $(CURDIR)/$(VENV)/python -m pytest tests/ -q
