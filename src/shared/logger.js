import winston from 'winston';

const { combine, timestamp, printf, colorize } = winston.format;
const logLevel = process.env.LOG_LEVEL || 'info';

const logFormat = printf(({ level, message, timestamp, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${level}] ${message}${metaStr}`;
});

export const logger = winston.createLogger({
    level: logLevel,
    format: combine(
        timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
        logFormat
    ),
    transports: [
        new winston.transports.Console({
            format: combine(colorize(), timestamp({ format: 'HH:mm:ss' }), logFormat),
        }),
        new winston.transports.File({
            filename: 'logs/error.log',
            level: 'error',
        }),
        new winston.transports.File({
            filename: 'logs/combined.log',
        }),
    ],
});
