# Laravel Log Email Inspector

A small inbox-style viewer for emails that a Laravel app writes to its log with the `log` mail driver. Instead of scrolling through `laravel.log`, you get a list of messages with rendered HTML, plain text, headers, attachments and raw source.

## Requirements

- Node.js 20.12 or newer (uses the built-in `process.loadEnvFile()`)
- A Laravel app with `MAIL_MAILER=log`

## Setup

```sh
npm install
cp .env.example .env
```

Edit `.env` and set `LOG_PATH` to your Laravel log file:

```env
LOG_PATH=/path/to/your-laravel-app/storage/logs/laravel.log
PORT=4321
```

## Usage

```sh
npm start
```

Then open http://localhost:4321.

Send an email from your Laravel app (password reset, notification, etc.) and reload the page. The log is re-parsed whenever the file changes.

## Configuration

| Variable   | Required | Default | Description                                           |
| ---------- | -------- | ------- | ----------------------------------------------------- |
| `LOG_PATH` | yes      | none    | Absolute path to the Laravel log file                 |
| `PORT`     | no       | `4321`  | Port the inspector listens on                         |

Variables set in your shell override `.env`:

```sh
LOG_PATH=/other/laravel.log PORT=5000 npm start
```

## How it works

- Laravel's `log` mail driver writes each message to the log as a raw RFC822 email.
- The server splits the log into entries, keeps the ones that look like emails, and parses them with [mailparser](https://nodemailer.com/extras/mailparser/).
- Inline `cid:` images are converted to data URIs so the HTML view looks like it would in a mail client.

### API

| Endpoint            | Description                                      |
| ------------------- | ------------------------------------------------ |
| `GET /api/emails`   | Summary list of all emails, newest first         |
| `GET /api/emails/:id` | Full email: text, HTML, headers and raw source |

## Privacy

Your Laravel log can contain real emails, reset links and personal data. The inspector only reads the file and serves it on localhost. Don't expose the port publicly, and don't commit logs or screenshots of real emails. `.env` is gitignored, so your local paths stay out of the repo.
