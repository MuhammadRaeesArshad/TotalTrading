import { Module } from '@nestjs/common';
import { OllamaModule } from '../ollama/ollama.module';
import { HealthController } from './health.controller';

@Module({
  imports: [OllamaModule],
  controllers: [HealthController],
})
export class HealthModule {}
