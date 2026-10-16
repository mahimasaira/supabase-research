import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // Every request body is checked against its DTO class. Unknown fields are an error (400),
  // not silently dropped: a client sending isBooked or status gets told no.
  // The Vue app runs on another origin (Vite), so the browser needs CORS permission.
  // Only the listed origins; comma-separated in CORS_ORIGINS (backend/.env) to change them.
  const origins = (process.env.CORS_ORIGINS ?? 'http://127.0.0.1:5173,http://localhost:5173').split(',').map((o) => o.trim());
  app.enableCors({ origin: origins });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }));
  await app.listen(process.env.PORT ?? 3000, '127.0.0.1');
}
bootstrap();
