# Content Pipeline Project - Celebrity Article Automation System

## Project Overview
Automated content pipeline for generating and publishing celebrity biography articles focused on dramatic stories, failures, and eventual success. Multi-platform publishing to social media.

## Tech Stack
- **Frontend**: React 18, TypeScript, Vite, TailwindCSS, React Router
- **Backend**: Node.js, Express, TypeScript
- **Database**: PostgreSQL with Prisma ORM
- **Queue System**: BullMQ with Redis
- **AI Services**: OpenAI GPT-4, Claude, Google Gemini
- **Media Processing**: FFmpeg, Sharp, Canvas
- **Publishing APIs**: Telegram, VK, Instagram, YouTube, Medium, Facebook, X/Twitter, LinkedIn

## Project Structure
```
content-pipeline/
├── packages/
│   ├── web/          # React frontend
│   ├── api/          # Express backend
│   └── shared/       # Shared types and utilities
├── prisma/           # Database schema
└── docs/             # Documentation
```

## Key Features
1. **AI Research Agent**: Gather biographical information from multiple sources
2. **Content Generator**: Create articles with 8-9 dramatic points, quotes, and images
3. **Cover Generator**: Find rare photos and apply branding template
4. **Multi-Platform Publisher**: Automated posting to 8+ platforms
5. **Text-to-Video**: Convert articles to YouTube videos with voiceover
6. **Approval Workflow**: Review and edit at each pipeline stage

## Development Guidelines
- Use TypeScript strict mode
- Follow async/await patterns
- Implement proper error handling
- Use environment variables for API keys
- Write modular, reusable code
- Add JSDoc comments for complex functions
