import { openInheritedControlChannel } from '@deepseek-ai/dsh-subprocess/control';

const control = openInheritedControlChannel();
process.stdout.write(`ready:${process.pid}:${JSON.stringify(Object.keys(process.env).sort())}\n`);
process.stdin.once('data', (bytes) => process.stdout.write(bytes));
control.once('data', (bytes) => control.write(bytes));
