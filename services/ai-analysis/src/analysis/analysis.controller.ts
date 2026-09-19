import { Body, Controller, Post } from '@nestjs/common';
import { AnalysisService } from './analysis.service';
import { AnalyzeDto, type AnalysisResult } from './dto';

@Controller('analyze')
export class AnalysisController {
  constructor(private readonly analysis: AnalysisService) {}

  @Post()
  analyze(@Body() dto: AnalyzeDto): Promise<AnalysisResult> {
    return this.analysis.analyze(dto);
  }
}
