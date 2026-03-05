import { Type } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

export class ImportDataDto {
  @IsBoolean()
  @IsOptional()
  @Type(() => Boolean)
  overwrite: boolean = false;
}
