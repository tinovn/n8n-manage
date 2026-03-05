import { IsEmail, IsNotEmpty, IsString, Matches } from 'class-validator';

export class ChangeDomainDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.[A-Za-z0-9-]{1,63})*(\.[A-Za-z]{2,})$/, {
    message: 'New domain format is not valid.',
  })
  newDomain: string;

  @IsEmail()
  @IsNotEmpty()
  newEmail: string;

  @IsNotEmpty()
  ip: string;
}
