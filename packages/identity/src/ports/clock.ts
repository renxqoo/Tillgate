/** 时钟 port:锚点/JWT iat/审计时间的单源注入(挑战域时间单源是 DB 时钟,DESIGN §3) */
export interface Clock {
  now(): Date;
}
