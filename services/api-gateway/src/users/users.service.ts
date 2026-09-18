import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { User, UserDocument } from '../schemas';

@Injectable()
export class UsersService {
  constructor(
    @InjectModel(User.name) private readonly model: Model<UserDocument>,
  ) {}

  findById(id: string) {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.model.findById(id).exec();
  }

  findByEmail(email: string) {
    return this.model.findOne({ email: email.toLowerCase() }).exec();
  }

  /** Includes the fields excluded by `select: false`. Only for the login path. */
  findByEmailWithSecrets(email: string) {
    return this.model
      .findOne({ email: email.toLowerCase() })
      .select('+passwordHash +refreshTokenHash')
      .exec();
  }

  findByIdWithSecrets(id: string) {
    if (!Types.ObjectId.isValid(id)) return null;
    return this.model.findById(id).select('+refreshTokenHash').exec();
  }

  create(data: Pick<User, 'email' | 'displayName' | 'passwordHash'>) {
    return this.model.create({ ...data, email: data.email.toLowerCase() });
  }

  count() {
    return this.model.estimatedDocumentCount().exec();
  }

  setRefreshTokenHash(id: string, hash: string | null) {
    return this.model.findByIdAndUpdate(id, { refreshTokenHash: hash }).exec();
  }

  markLogin(id: string) {
    return this.model.findByIdAndUpdate(id, { lastLoginAt: new Date() }).exec();
  }
}
