import { stripIndents } from 'common-tags';
import { compile } from 'handlebars';
import { format } from 'date-fns';

export enum TimeSensitivity {
  Day = 'yyyy-MM-dd EEEE BBBB',
  Hour = 'yyyy-MM-dd EEEE HH BBBB',
  Minute = 'yyyy-MM-dd EEEE HH:mm BBBB',
}

export function createPromptContext<Context>(
  id: string,
  context: Context,
  sensitivity: TimeSensitivity = TimeSensitivity.Minute,
) {
  return (prompt: string) =>
    compile(stripIndents`
      ID:{{id}} Now:{{now}}
      ------
      ${prompt}
    `)({ ...context, id, now: format(new Date(), sensitivity) });
}
