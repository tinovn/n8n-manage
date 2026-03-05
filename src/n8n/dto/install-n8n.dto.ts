import { IsEmail, IsNotEmpty, IsString, Matches } from 'class-validator';

export class InstallN8nDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.[A-Za-z0-9-]{1,63})*(\.[A-Za-z]{2,})$/, {
    message: 'Domain format is not valid.',
  })
  domain: string;

  @IsEmail()
  @IsNotEmpty()
  email: string;
}
