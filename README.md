# Khloei

Khloei is a [Next.js](https://nextjs.org) application.

It uses the OpenAI Responses API with `gpt-5.6-terra`, streamed output, web
search citations, multimodal attachments, and Markdown rendering. Deep Research
runs with `gpt-5.6-sol` in OpenAI background mode, so a long response can resume
after a transient disconnect, a serverless timeout, or a browser reload. Stop and
New Chat also cancel the active background response at OpenAI.

## Getting Started

Run the Khloei development server:

1. Add your API key to `.env.local`:

```bash
OPENAI_API_KEY=your_key_here
```

2. Start the app:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).
