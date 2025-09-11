# Cat Scratch Slack Bot

## Overview

Cat Scratch is a comprehensive Slack bot designed for team productivity and communication management. The bot specializes in scheduled messaging, interactive polling, and team capacity tracking. It provides automated daily check-ins, help request systems, and customizable message scheduling with recurring options. The bot features a cat-themed interface and supports real-time interactions through Slack's interactive components.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Core Application Structure
The application follows a modular Node.js architecture built around Slack's Bolt framework. The main entry point (`index.js`) orchestrates all bot functionality including command handlers, scheduled job management, and interactive component processing.

### Message Scheduling System
The bot implements a sophisticated scheduling system using `node-cron` for time-based job execution. Messages are stored in JSON files and loaded at startup, with automatic cleanup of expired one-time messages. The scheduler supports:
- One-time message delivery with date/time validation
- Recurring schedules (daily, weekly, monthly)
- EST timezone handling with automatic conversion
- Past-date validation to prevent invalid scheduling

### Interactive Component Architecture
The bot uses Slack's Block Kit framework for rich interactive experiences. Key components include:
- Modal-based message composition with multi-step workflows
- Real-time polling with live vote updates
- Emergency help button system with multi-channel alerting
- Capacity check messages with emoji reaction tracking

### Data Persistence Strategy
The application uses file-based JSON storage for simplicity and reliability:
- `scheduledMessages.json` - Stores all scheduled message configurations
- `pollData.json` - Tracks voting data and poll responses
- `data/messages.json` - Message history and metadata
- `data/polls.json` - Detailed poll configurations and vote tracking

### Event-Driven Processing
The bot processes various Slack events through dedicated handlers:
- Slash command processing for `/cat` commands
- Interactive component responses (buttons, modals, selects)
- Real-time vote tracking and UI updates
- Scheduled job execution and cleanup

### Keep-Alive Infrastructure
The bot includes an Express.js health monitoring server that provides:
- Status dashboard with uptime and job statistics
- Health check endpoint for monitoring systems
- Bot status visualization for administrators

## External Dependencies

### Slack Integration
- **@slack/bolt**: Primary framework for Slack app development
- **Slack Bot Token**: Required for posting messages and accessing channels
- **Slack App Token**: Enables Socket Mode for real-time event handling
- **Slack Signing Secret**: Validates incoming requests from Slack

### Time Management Libraries
- **node-cron**: Handles scheduled job execution with cron-like syntax
- **dayjs**: Lightweight date/time manipulation and formatting
- **luxon**: Advanced timezone handling and date operations
- **moment-timezone**: Legacy timezone support for compatibility

### Infrastructure Dependencies
- **express**: Web server for health monitoring and status endpoints
- **dotenv**: Environment variable management for configuration
- **fs**: Native Node.js file system operations for data persistence

### Development Tools
- **@types/node**: TypeScript definitions for Node.js development