# bitwarden-login — OpenClaw スキル

[English](README.md) | 日本語

[OpenClaw](https://github.com/openclaw/openclaw) のエージェントが、**パスワードを一度も見ずに**サイトへログインできるようにするスキルです。ログイン情報は、チャットに書く代わりに一回限りの安全なページから保存できます。

- **使えるけど、見えない。** `bwl.sh login netflix` は Bitwarden からログイン情報を取り出し、OpenClaw のブラウザに直接入力します。エージェントが受け取るのは `{"status":"logged-in"}` だけです。パスワードを表示するコマンドはありません。
- **正しいサイトにだけ入力。** ページが https で、保存されたホスト（またはそのサブドメイン）のときだけ入力します。メッセージにだまされて偽サイトを開いても、何も入力しません。
- **チャットを使わずに保存。** `bwl.sh add netflix https://www.netflix.com/login` で一回限りのリンクができ、エージェントがあなたに送ります。スマホで開いて普通のパスワード欄に入力すると、そのまま保管庫に保存されます。
- **2 段階認証はあなたの手元に。** コードを求められたら、エージェントがあなたに聞きます。2 段階認証の秘密鍵は保存しません。

## パスワードをエージェントから遠ざける仕組み

| リスク | このツールの対策 |
|---|---|
| エージェントがパスワードを読む | パスワードを出力するコマンドはありません。スクリプトは結果だけを出力します。スキルは `bw` やキーチェーンを直接使わないようエージェントに指示します。 |
| ログやプロセス一覧に漏れる | パスワードはパイプでだけ受け渡し、コマンドライン引数には載せません。ブラウザは DevTools のソケットで直接操作するので、OpenClaw のツールログにも残りません。`tests/leak-test.sh` で確認できます。 |
| プロンプトインジェクションで偽サイトへ誘導 | 保存されたサイトの https ページでだけ入力し、各欄に入力する直前にも確認します。 |
| ほかのアカウントに入られる | エージェントには**専用の Bitwarden アカウント**を使い、渡したログインだけを入れます。使うのは `claw` フォルダの項目だけです。 |
| 保管庫が開いたまま | コマンドごとに解錠し、すぐに施錠します。解錠用パスワードはファイルではなく macOS のキーチェーンに保存します。 |
| 保存リンクの悪用 | あなたの Tailscale ネットワーク内でしか開けません。ランダムな鍵付きで、一回だけ使え、10 分で無効になります。ページはほかのどこにもデータを送りません。 |
| 何が起きたか分からない | すべてのコマンドを `~/.openclaw/workspace/data/bitwarden-login.log` に記録します（時刻・コマンド・サイト・結果）。パスワードは記録しません。 |

**防げないもの：** サイト自体の乗っ取り、すでに Mac 上であなたとして動いているマルウェア（キーチェーンも読めます）、スキルを無視して `bw` や `security` を自分で実行するエージェント（この 2 つは OpenClaw の実行許可リストに入れず、毎回あなたの確認が必要なままにしてください）、あなた自身が許可してしまったログイン。ログイン済みのブラウザはパスワードと同じ力を持つので、エージェントに使わせてよいログインだけを保存してください。

スクリプトは短いので、中身を読んで確かめられます：`scripts/bwl.sh`（保管庫）、`scripts/fill.mjs`（ブラウザ）、`scripts/add-server.mjs`（保存ページ）。

## インストール

```sh
brew install bitwarden-cli jq
git clone https://github.com/hlum/openclaw-bitwarden-login
cp -r openclaw-bitwarden-login/bitwarden-login ~/.openclaw/workspace/skills/
```

1. **エージェント専用の新しい無料 Bitwarden アカウント**を作ります。個人の保管庫は使わないでください（セルフホストや EU サーバーの場合は先に `bw config server <url>`）。
2. ターミナルで `~/.openclaw/workspace/skills/bitwarden-login/scripts/bwl.sh setup` を実行します。そのアカウントにログインし、マスターパスワードを macOS のキーチェーンに保存し、`claw` フォルダを作ります。
3. 任意：毎回の確認なしで実行できるようにします：
   `openclaw approvals allowlist add --agent main "~/.openclaw/workspace/skills/bitwarden-login/scripts/bwl.sh"`

OpenClaw のブラウザが起動していること（デバッグポートは既定で `http://127.0.0.1:18800`、違う場合は `BWL_CDP` を設定）と Node 22 以上が必要です。保存リンクには Mac とスマホの両方に [Tailscale](https://tailscale.com) が必要です。ない場合は Mac の前で `add ... --local` を使うか、Bitwarden アプリで `claw` フォルダに追加してください。

## 使い方

```sh
S=~/.openclaw/workspace/skills/bitwarden-login/scripts
$S/bwl.sh list                                         # [{"site":"netflix","host":"www.netflix.com"}]
$S/bwl.sh login netflix                                # {"ok":true,"status":"logged-in",...}
$S/bwl.sh code netflix 123456                          # "needs-code" のあと
$S/bwl.sh add netflix https://www.netflix.com/login    # あなた用の一回限りのリンク
```

たいていのサイトは何も追加せずに動きます（メール → パスワードの 2 段階のページも含む）。特殊なログインページは、Bitwarden の項目にカスタムフィールド `claw-user`・`claw-pass`・`claw-next`（値は CSS セレクタ）を追加します。

設定（環境変数）：`BWL_FOLDER`（`claw`）、`BWL_LOG`、`BWL_CDP`、`BWL_TS_PORT`（保存ページの tailnet ポート、`8443`）。

## テスト

```sh
~/.openclaw/workspace/skills/bitwarden-login/tests/leak-test.sh
```

本物の OpenClaw ブラウザで偽のログインサイトに対して試します：1 ページ・2 段階・2 段階認証のログインと、別ホストへのリダイレクトと http（どちらも拒否されること）。そのあと、ランダムなテスト用パスワードが偽サイト以外（出力、OpenClaw のログ、エージェントのセッション、プロセス一覧）に現れないことを確認します。テストに Bitwarden アカウントは要りません。

## 制限

- iframe 内のログインやパスキーのみのサイトには対応していません。CAPTCHA は一度あなたが必要です。
- 「Google/Apple でログイン」は、そのログインも保存してあるときだけ動きます。
- macOS のみ（キーチェーン、`osascript`）。

> 自動ログインはサイトの利用規約に反する場合があります。自分のアカウントで使ってください。

## ライセンス

MIT
