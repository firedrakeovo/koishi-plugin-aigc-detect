import { Context, Schema } from 'koishi'

export declare const name = 'ai-image-detect'

export interface Config {
  channel: 'sightengine'
  apiUser: string
  apiSecret: string
  proxy: string
  timeout: number
  cacheHours: number
  highThreshold: number
  lowThreshold: number
  enableUserLimit: boolean
  dailyLimitPerUser: number
  enableChannelLimit: boolean
  dailyLimitPerChannel: number
}

export declare const Config: Schema<Config>

export declare function apply(ctx: Context, config: Config): void
