import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class UpdateVersionDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^\d+\.\d+\.\d+$/, {
    message: 'Version must be in semantic format X.Y.Z (e.g., 1.95.3)',
  })
  version: string;
}
